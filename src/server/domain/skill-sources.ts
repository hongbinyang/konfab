import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseDocument } from "yaml";
import type { Db } from "../db/index.js";
import { indexArchive } from "./source-archive.js";
import { skillMetadata } from "./skill-files.js";
import { SkillError } from "./skill-error.js";

const DEFAULTS = [
  ["anthropics", "skills", "vendor", 1],
  ["openai", "plugins", "vendor", 1],
  ["vercel-labs", "agent-skills", "vendor", 0],
  ["obra", "superpowers", "community", 0],
  ["mattpocock", "skills", "community", 0],
  ["microsoft", "skills", "vendor", 0],
  ["huggingface", "skills", "vendor", 0],
] as const;
const PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[a-f0-9]{40}$/;

type Source = {
  id: string;
  owner: string;
  repository: string;
  ref: string;
  badge: "vendor" | "community";
  enabled: number;
  current_generation_id: string | null;
  etag: string | null;
  last_checked_at: number | null;
  rate_limit_reset: number | null;
};
export type SourceOptions = {
  cacheBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
  token?: string;
  notify?: () => void;
};

export class SkillSources {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheBytes: number;
  private readonly token: string | undefined;
  private readonly notify: () => void;
  private job: {
    sourceId: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  constructor(
    private readonly db: Db,
    options: SourceOptions = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheBytes = options.cacheBytes ?? 500 * 1024 * 1024;
    this.token = options.token;
    this.notify = options.notify ?? (() => {});
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE source_generations SET state = 'failed', error = 'Refresh interrupted', cache_bytes = 0 WHERE state IN ('downloading','indexing')",
        )
        .run();
      this.db
        .prepare(
          "DELETE FROM source_entries WHERE generation_id IN (SELECT id FROM source_generations WHERE state = 'failed')",
        )
        .run();
      this.db
        .prepare(
          "DELETE FROM source_manifests WHERE generation_id IN (SELECT id FROM source_generations WHERE state = 'failed')",
        )
        .run();
    })();
    const add = this.db.prepare(
      "INSERT OR IGNORE INTO skill_sources(id, owner, repository, ref, badge, enabled) VALUES (?, ?, ?, 'HEAD', ?, ?)",
    );
    for (const [owner, repository, badge, enabled] of DEFAULTS)
      add.run(randomUUID(), owner, repository, badge, enabled);
  }
  list(): Array<{
    id: string;
    owner: string;
    repository: string;
    ref: string;
    badge: "vendor" | "community";
    enabled: number;
    current_generation_id: string | null;
    current_commit: string | null;
    last_checked_at: number | null;
    rate_limit_reset: number | null;
    latest: null | {
      id: string;
      commit_id: string;
      state: string;
      discovered: number;
      indexed: number;
      error: string | null;
      completed_at: number | null;
    };
  }> {
    return this.db
      .prepare(
        `SELECT s.id, s.owner, s.repository, s.ref, s.badge, s.enabled, s.current_generation_id, s.last_checked_at, s.rate_limit_reset,
      (SELECT json_object('id', g.id, 'commit_id', g.commit_id, 'state', g.state, 'discovered', g.discovered, 'indexed', g.indexed, 'error', g.error, 'completed_at', g.completed_at)
       FROM source_generations g WHERE g.source_id = s.id ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1) AS latest_json,
      (SELECT commit_id FROM source_generations WHERE id = s.current_generation_id) AS current_commit
      FROM skill_sources s ORDER BY s.enabled DESC, s.owner, s.repository`,
      )
      .all()
      .map((row) => {
        const result = row as Record<string, unknown>;
        return {
          ...result,
          latest: result.latest_json
            ? JSON.parse(String(result.latest_json))
            : null,
          latest_json: undefined,
        };
      }) as unknown as ReturnType<SkillSources["list"]>;
  }
  add(owner: string, repository: string, ref = "HEAD"): string {
    owner = owner.toLowerCase();
    repository = repository.toLowerCase();
    if (
      !PART.test(owner) ||
      !PART.test(repository) ||
      owner === "." ||
      owner === ".." ||
      repository === "." ||
      repository === ".." ||
      !/^[A-Za-z0-9_./-]{1,200}$/.test(ref) ||
      ref.includes("..") ||
      ref.startsWith("/") ||
      ref.endsWith("/")
    )
      throw new SkillError(
        "invalid_source",
        400,
        "Enter a valid GitHub owner, repository and ref",
      );
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO skill_sources(id, owner, repository, ref, badge, enabled) VALUES (?, ?, ?, ?, 'community', 1)",
        )
        .run(id, owner, repository, ref);
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT"))
        throw new SkillError("source_exists", 409, "Source already exists");
      throw error;
    }
    this.notify();
    return id;
  }
  setEnabled(id: string, enabled: boolean): void {
    const result = this.db
      .prepare("UPDATE skill_sources SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    if (!result.changes)
      throw new SkillError("source_missing", 404, "Source not found");
    if (!enabled && this.job?.sourceId === id) this.job.controller.abort();
    this.notify();
  }
  setTokenEnabled(enabled: boolean): void {
    if (enabled && !this.token)
      throw new SkillError(
        "token_missing",
        400,
        "Set KONFAB_GITHUB_TOKEN before enabling authenticated access",
      );
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('source_token_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(enabled ? "1" : "0");
    this.notify();
  }
  tokenState() {
    return {
      available: !!this.token,
      enabled:
        this.db
          .prepare(
            "SELECT value FROM settings WHERE key = 'source_token_enabled'",
          )
          .get() !== undefined &&
        (
          this.db
            .prepare(
              "SELECT value FROM settings WHERE key = 'source_token_enabled'",
            )
            .get() as { value: string }
        ).value === "1",
    };
  }
  private source(id: string): Source {
    const source = this.db
      .prepare("SELECT * FROM skill_sources WHERE id = ?")
      .get(id) as Source | undefined;
    if (!source)
      throw new SkillError("source_missing", 404, "Source not found");
    return source;
  }
  browse(id: string, query = "") {
    const source = this.source(id);
    if (!source.current_generation_id)
      return { commit: null, generation_id: null, skills: [] };
    this.db
      .prepare(
        "UPDATE source_generations SET last_accessed_at = ? WHERE id = ?",
      )
      .run(this.now(), source.current_generation_id);
    const skills = this.db
      .prepare(
        `SELECT path, name, description, licence, diagnostic FROM source_manifests WHERE generation_id = ? AND indexed = 1 AND (instr(lower(COALESCE(name,'') || ' ' || COALESCE(description,'') || ' ' || path), lower(?)) > 0) ORDER BY path LIMIT 10000`,
      )
      .all(source.current_generation_id, query);
    const generation = this.db
      .prepare(
        "SELECT commit_id FROM source_generations WHERE id = ? AND state = 'complete'",
      )
      .get(source.current_generation_id) as { commit_id: string } | undefined;
    return {
      commit: generation?.commit_id ?? null,
      generation_id: source.current_generation_id,
      skills,
    };
  }
  preview(id: string, generationId: string, path: string) {
    const source = this.source(id);
    const belongs = this.db
      .prepare(
        "SELECT 1 FROM source_generations WHERE id = ? AND source_id = ? AND state = 'complete'",
      )
      .get(generationId, id);
    if (!belongs)
      throw new SkillError("source_unavailable", 404, "No cached source index");
    const manifest = this.db
      .prepare(
        "SELECT * FROM source_manifests WHERE generation_id = ? AND path = ? AND indexed = 1",
      )
      .get(generationId, path) as
      | {
          content: Buffer | null;
          name: string | null;
          description: string | null;
          licence: string | null;
          diagnostic: string | null;
        }
      | undefined;
    if (!manifest)
      throw new SkillError(
        "skill_missing",
        404,
        "Skill not found in cached index",
      );
    const prefix = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/") + 1)
      : "";
    const entries = this.db
      .prepare(
        "SELECT path, size, kind FROM source_entries WHERE generation_id = ? AND substr(path, 1, ?) = ? ORDER BY path",
      )
      .all(generationId, prefix.length, prefix);
    const nested = (
      this.db
        .prepare(
          "SELECT path FROM source_manifests WHERE generation_id = ? AND path != ? AND substr(path, 1, ?) = ?",
        )
        .all(generationId, path, prefix.length, prefix) as { path: string }[]
    ).map((item) => item.path.slice(0, item.path.lastIndexOf("/") + 1));
    const nestedRoots = new Set(nested);
    const filteredEntries = entries.filter((item) => {
      const relative = (item as { path: string }).path.slice(prefix.length);
      const parts = relative.split("/");
      let parent = prefix;
      for (let index = 0; index < parts.length - 1; index += 1) {
        parent += `${parts[index]}/`;
        if (nestedRoots.has(parent)) return false;
      }
      return true;
    });
    const generation = this.db
      .prepare(
        "SELECT commit_id FROM source_generations WHERE id = ? AND state = 'complete'",
      )
      .get(generationId) as { commit_id: string };
    return {
      source: `${source.owner}/${source.repository}`,
      commit: generation.commit_id,
      path,
      name: manifest.name,
      description: manifest.description,
      licence: manifest.licence,
      diagnostic: manifest.diagnostic,
      content: manifest.content?.toString("utf8") ?? null,
      files: filteredEntries,
    };
  }
  startRefresh(id: string): void {
    if (this.job)
      throw new SkillError("source_busy", 409, "Another source is refreshing");
    const source = this.source(id);
    if (!source.enabled)
      throw new SkillError("source_disabled", 400, "Enable this source first");
    const controller = new AbortController();
    const promise = this.refresh(source, controller.signal)
      .catch(() => {})
      .finally(() => {
        this.job = null;
        this.notify();
      });
    this.job = { sourceId: id, controller, promise };
  }
  cancel(id: string): void {
    if (this.job?.sourceId !== id)
      throw new SkillError(
        "source_not_refreshing",
        409,
        "Source is not refreshing",
      );
    this.job.controller.abort();
  }
  async waitForRefresh(): Promise<void> {
    await this.job?.promise;
  }
  async close(): Promise<void> {
    this.job?.controller.abort();
    await this.job?.promise;
  }
  private async response(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["api.github.com", "codeload.github.com"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new SkillError("invalid_source", 400, "Source host is not allowed");
    const response = await this.fetcher(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.status !== 304
    )
      throw new SkillError(
        "source_redirect",
        502,
        "Source redirected to an unexpected location",
      );
    return response;
  }
  private async boundedJson(response: Response): Promise<unknown> {
    if (!response.body)
      throw new SkillError("source_error", 502, "Empty source response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1024 * 1024)
          throw new SkillError(
            "source_limit",
            413,
            "Source response exceeds its limit",
          );
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new SkillError("source_error", 502, "Invalid source response");
    }
  }
  private async refresh(source: Source, signal: AbortSignal): Promise<void> {
    let generation: string | null = null;
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Konfab",
      };
      if (this.token && this.tokenState().enabled)
        headers.Authorization = `Bearer ${this.token}`;
      if (source.etag && source.current_generation_id)
        headers["If-None-Match"] = source.etag;
      const api = await this.response(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/commits/${encodeURIComponent(source.ref)}`,
        headers,
        signal,
      );
      if (api.status === 304) {
        this.db
          .prepare(
            "UPDATE skill_sources SET last_checked_at = ?, rate_limit_reset = NULL WHERE id = ?",
          )
          .run(this.now(), source.id);
        return;
      }
      if (
        api.status === 429 ||
        (api.status === 403 && api.headers.get("x-ratelimit-remaining") === "0")
      ) {
        const reset = Number(api.headers.get("x-ratelimit-reset"));
        this.db
          .prepare("UPDATE skill_sources SET rate_limit_reset = ? WHERE id = ?")
          .run(
            Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
            source.id,
          );
        throw new SkillError(
          "source_rate_limited",
          429,
          "GitHub rate limit reached",
        );
      }
      if (!api.ok)
        throw new SkillError(
          "source_error",
          502,
          `GitHub request failed (${api.status})`,
        );
      const payload = (await this.boundedJson(api)) as { sha?: unknown };
      const commit =
        typeof payload.sha === "string" ? payload.sha.toLowerCase() : "";
      if (!SHA.test(commit))
        throw new SkillError(
          "source_error",
          502,
          "GitHub returned an invalid commit",
        );
      const etag = api.headers.get("etag");
      if (source.current_generation_id) {
        const current = this.db
          .prepare(
            "SELECT commit_id FROM source_generations WHERE id = ? AND state = 'complete'",
          )
          .get(source.current_generation_id) as
          { commit_id: string } | undefined;
        if (current?.commit_id === commit) {
          this.db
            .prepare(
              "UPDATE skill_sources SET etag = ?, last_checked_at = ?, rate_limit_reset = NULL WHERE id = ?",
            )
            .run(etag?.slice(0, 500) ?? null, this.now(), source.id);
          return;
        }
      }
      generation = randomUUID();
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO source_generations(id, source_id, commit_id, state, created_at, last_accessed_at) VALUES (?, ?, ?, 'downloading', ?, ?)",
        )
        .run(generation, source.id, commit, now, now);
      this.notify();
      const response = await this.response(
        `https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/tar.gz/${commit}`,
        { "User-Agent": "Konfab" },
        signal,
      );
      if (!response.ok || !response.body)
        throw new SkillError(
          "source_error",
          502,
          "Unable to download source archive",
        );
      const gen = generation;
      const entryInsert = this.db.prepare(
        "INSERT INTO source_entries(generation_id, path, size, kind) VALUES (?, ?, ?, ?)",
      );
      const manifestInsert = this.db.prepare(
        "INSERT INTO source_manifests(generation_id, path, content, diagnostic) VALUES (?, ?, ?, ?)",
      );
      let bytes = 0,
        found = 0;
      await indexArchive(
        Readable.fromWeb(response.body as unknown as NodeReadableStream),
        (entry) => {
          bytes +=
            Buffer.byteLength(entry.path) + 256 + (entry.manifest?.length ?? 0);
          if (bytes > this.cacheBytes)
            throw new SkillError(
              "source_limit",
              413,
              "Source index exceeds cache limit",
            );
          entryInsert.run(gen, entry.path, entry.size, entry.kind);
          if (entry.manifest !== undefined) {
            found += 1;
            manifestInsert.run(
              gen,
              entry.path,
              entry.manifest,
              entry.manifest === null ? "Manifest exceeds 512 KiB" : null,
            );
          }
          if (entry.manifest !== undefined && found % 25 === 0)
            this.db
              .prepare(
                "UPDATE source_generations SET discovered = ?, cache_bytes = ? WHERE id = ?",
              )
              .run(found, bytes, gen);
        },
        undefined,
        signal,
      );
      this.db
        .prepare(
          "UPDATE source_generations SET state = 'indexing', discovered = ?, cache_bytes = ? WHERE id = ?",
        )
        .run(found, bytes, gen);
      this.notify();
      const rowQuery = this.db.prepare(
        "SELECT path, content, diagnostic FROM source_manifests WHERE generation_id = ? ORDER BY path LIMIT 25 OFFSET ?",
      );
      const update = this.db.prepare(
        "UPDATE source_manifests SET name = ?, description = ?, licence = ?, diagnostic = ?, indexed = 1 WHERE generation_id = ? AND path = ?",
      );
      let indexed = 0;
      while (indexed < found) {
        const rows = rowQuery.all(gen, indexed) as {
          path: string;
          content: Buffer | null;
          diagnostic: string | null;
        }[];
        if (!rows.length) break;
        for (const row of rows) {
          if (signal.aborted)
            throw new SkillError("source_cancelled", 400, "Refresh cancelled");
          let name: string | null = null,
            description: string | null = null,
            licence: string | null = null,
            diagnostic = row.diagnostic;
          if (row.content)
            try {
              const meta = skillMetadata([
                { path: "SKILL.md", content: row.content, mode: 0o600 },
              ]);
              name = meta.name;
              description = meta.description;
              const parent = row.path.split("/").at(-2) ?? source.repository;
              if (parent !== name)
                diagnostic = "Skill name does not match its folder";
              const text = row.content.toString("utf8");
              const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
              const value = match?.[1]
                ? (parseDocument(match[1]).toJS({ maxAliasCount: 0 }) as Record<
                    string,
                    unknown
                  >)
                : null;
              if (
                typeof value?.license === "string" &&
                value.license.length <= 500
              )
                licence = value.license;
            } catch (error) {
              diagnostic =
                error instanceof SkillError
                  ? error.message
                  : "Invalid skill metadata";
            }
          update.run(name, description, licence, diagnostic, gen, row.path);
          indexed += 1;
        }
        this.db
          .prepare("UPDATE source_generations SET indexed = ? WHERE id = ?")
          .run(indexed, gen);
        this.notify();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (signal.aborted)
        throw new SkillError("source_cancelled", 400, "Refresh cancelled");
      this.promote(source.id, gen, etag);
    } catch (error) {
      const message = signal.aborted
        ? "Refresh cancelled"
        : error instanceof SkillError
          ? error.message
          : "Unable to refresh source";
      if (!generation) {
        generation = randomUUID();
        this.db
          .prepare(
            "INSERT INTO source_generations(id, source_id, commit_id, state, error, created_at, last_accessed_at) VALUES (?, ?, '', 'failed', ?, ?, ?)",
          )
          .run(generation, source.id, message, this.now(), this.now());
      } else
        this.db.transaction(() => {
          this.db
            .prepare("DELETE FROM source_entries WHERE generation_id = ?")
            .run(generation);
          this.db
            .prepare("DELETE FROM source_manifests WHERE generation_id = ?")
            .run(generation);
          this.db
            .prepare(
              "UPDATE source_generations SET state = 'failed', error = ?, cache_bytes = 0 WHERE id = ?",
            )
            .run(message, generation);
        })();
      this.notify();
    }
  }
  private promote(
    sourceId: string,
    generation: string,
    etag: string | null,
  ): void {
    this.db.transaction(() => {
      const incoming = this.db
        .prepare("SELECT cache_bytes FROM source_generations WHERE id = ?")
        .get(generation) as { cache_bytes: number };
      let total =
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_generations WHERE state = 'complete'",
            )
            .get() as { n: number }
        ).n + incoming.cache_bytes;
      const evictable = this.db
        .prepare(
          `SELECT g.id, g.cache_bytes FROM source_generations g WHERE g.state = 'complete' AND g.id NOT IN (SELECT current_generation_id FROM skill_sources WHERE current_generation_id IS NOT NULL AND id != ? AND enabled = 1) ORDER BY g.last_accessed_at`,
        )
        .all(sourceId) as { id: string; cache_bytes: number }[];
      for (const row of evictable) {
        if (total <= this.cacheBytes) break;
        this.db
          .prepare(
            "UPDATE skill_sources SET current_generation_id = NULL, etag = NULL WHERE current_generation_id = ?",
          )
          .run(row.id);
        this.db
          .prepare("DELETE FROM source_generations WHERE id = ?")
          .run(row.id);
        total -= row.cache_bytes;
      }
      if (total > this.cacheBytes)
        throw new SkillError(
          "source_cache_full",
          413,
          "Source cache is full; disable or remove another source",
        );
      this.db
        .prepare(
          "UPDATE source_generations SET state = 'complete', completed_at = ?, last_accessed_at = ? WHERE id = ?",
        )
        .run(this.now(), this.now(), generation);
      this.db
        .prepare(
          "UPDATE skill_sources SET current_generation_id = ?, etag = ?, last_checked_at = ?, rate_limit_reset = NULL WHERE id = ?",
        )
        .run(generation, etag?.slice(0, 500) ?? null, this.now(), sourceId);
    })();
    this.notify();
  }
}
