import type { TokenSource } from "../github-token.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseDocument } from "yaml";
import type { Db } from "../db/index.js";
import { extractVerifiedPackage, indexArchive } from "./source-archive.js";
import { skillMetadata, type SkillFile } from "./skill-files.js";
import { SkillError } from "./skill-error.js";
import { GitHubClient } from "./github-client.js";
import { LiveSources } from "./live-sources.js";

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
  tokenSource?: TokenSource;
  notify?: () => void;
};

export class SkillSources {
  private readonly github: GitHubClient;
  readonly live: LiveSources;
  private readonly now: () => number;
  private readonly cacheBytes: number;
  private readonly token: string | undefined;
  private readonly tokenSource: TokenSource;
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
    this.github = new GitHubClient(
      options.fetch ?? fetch,
      options.now ?? Date.now,
    );
    this.now = options.now ?? Date.now;
    this.cacheBytes = options.cacheBytes ?? 500 * 1024 * 1024;
    this.token = options.token;
    this.tokenSource =
      options.tokenSource ?? (options.token ? "environment" : "unavailable");
    this.live = new LiveSources(
      this.github,
      () => this.list(),
      () => this.enabledToken(),
      this.now,
    );
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
    if (!PART.test(owner))
      throw new SkillError(
        "invalid_source",
        400,
        "Owner: use 1–100 letters, numbers, underscores, periods or hyphens, starting with a letter, number or underscore; no spaces.",
      );
    if (!PART.test(repository))
      throw new SkillError(
        "invalid_source",
        400,
        "Repository: use 1–100 letters, numbers, underscores, periods or hyphens, starting with a letter, number or underscore; no spaces.",
      );
    if (
      !/^[A-Za-z0-9_./-]{1,200}$/.test(ref) ||
      ref.includes("..") ||
      ref.startsWith("/") ||
      ref.endsWith("/")
    )
      throw new SkillError(
        "invalid_source",
        400,
        "Ref: use 1–200 letters, numbers, underscores, periods, slashes or hyphens; no spaces, consecutive periods, or leading or trailing slash.",
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
      source: this.tokenSource,
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
  private enabledToken(): string | undefined {
    if (!this.tokenState().enabled) return undefined;
    if (!this.token)
      throw new SkillError(
        "token_missing",
        400,
        "The enabled GitHub token is unavailable; restart with it or disable token use.",
      );
    return this.token;
  }
  githubStatus() {
    const token = this.tokenState();
    const authenticated = token.enabled && token.available;
    return {
      mode: authenticated ? ("token" as const) : ("public" as const),
      ...this.github.statusFor(authenticated),
    };
  }
  async checkGithub() {
    const token = this.enabledToken();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Konfab",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await this.github.request(
        "https://api.github.com/rate_limit",
        headers,
        AbortSignal.timeout(15000),
      );
      await response.body?.cancel();
    } catch {
      throw new SkillError(
        "github_unavailable",
        502,
        "GitHub status check failed; try again later.",
      );
    }
    this.notify();
    return this.githubStatus();
  }
  private source(id: string): Source {
    const source = this.db
      .prepare("SELECT * FROM skill_sources WHERE id = ?")
      .get(id) as Source | undefined;
    if (!source)
      throw new SkillError("source_missing", 404, "Source not found");
    return source;
  }
  async latestPublicCommit(sourceName: string): Promise<string | null> {
    const source = this.list().find(
      (item) =>
        `${item.owner}/${item.repository}`.toLowerCase() ===
          sourceName.toLowerCase() && item.enabled,
    );
    if (!source) return null;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Konfab",
    };
    const token = this.enabledToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.response(
      `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/commits/${encodeURIComponent(source.ref)}`,
      headers,
      AbortSignal.timeout(15_000),
    );
    if (!response.ok || response.headers.get("x-konfab-stale") === "1")
      return null;
    const value = (await this.boundedJson(response)) as { sha?: unknown };
    return typeof value.sha === "string" && SHA.test(value.sha.toLowerCase())
      ? value.sha.toLowerCase()
      : null;
  }

  async publicSkillUpdate(
    sourceName: string,
    pinned: string,
    manifestPath: string,
  ): Promise<"changed" | "removed" | "unchanged" | "unknown"> {
    if (
      !/^[a-f0-9]{40}$/.test(pinned) ||
      !manifestPath ||
      manifestPath.startsWith("/") ||
      /[\\\0]/.test(manifestPath) ||
      manifestPath
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      manifestPath.split("/").at(-1) !== "SKILL.md"
    )
      return "unknown";
    const source = this.list().find(
      (item) =>
        `${item.owner}/${item.repository}`.toLowerCase() ===
          sourceName.toLowerCase() && item.enabled,
    );
    if (!source) return "unknown";
    const latest = await this.latestPublicCommit(sourceName);
    if (!latest) return "unknown";
    if (latest === pinned) return "unchanged";
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Konfab",
    };
    const token = this.enabledToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const folder = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
      : "";
    const findTree = async (
      commit: string,
    ): Promise<string | null | undefined> => {
      const response = await this.response(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/git/trees/${commit}?recursive=1`,
        headers,
        AbortSignal.timeout(15_000),
      );
      if (!response.ok || response.headers.get("x-konfab-stale") === "1")
        return undefined;
      const payload = (await this.boundedJson(response, 10 * 1024 * 1024)) as {
        sha?: unknown;
        tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }>;
        truncated?: boolean;
      };
      if (payload.truncated || !Array.isArray(payload.tree)) return undefined;
      const value = folder
        ? payload.tree.find(
            (entry) => entry.path === folder && entry.type === "tree",
          )?.sha
        : payload.sha;
      return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
        ? value.toLowerCase()
        : null;
    };
    const [before, after] = await Promise.all([
      findTree(pinned),
      findTree(latest),
    ]);
    if (before === undefined || after === undefined || before === null)
      return "unknown";
    if (after === null) return "removed";
    return before === after ? "unchanged" : "changed";
  }

  legacyIndexSize(): number {
    const rows = this.db
      .prepare(
        "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_generations",
      )
      .get() as { n: number };
    const packages = this.db
      .prepare(
        "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_cached_packages",
      )
      .get() as { n: number };
    return rows.n + packages.n;
  }
  removeLegacyIndexes(): void {
    if (this.job)
      throw new SkillError(
        "source_busy",
        409,
        "Wait for the current source refresh to finish.",
      );
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE skill_sources SET current_generation_id=NULL, etag=NULL, last_checked_at=NULL",
        )
        .run();
      this.db.prepare("DELETE FROM source_generations").run();
      this.db
        .prepare(
          "DELETE FROM source_cached_blobs WHERE sha NOT IN (SELECT sha FROM source_cached_files)",
        )
        .run();
    })();
    this.notify();
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
  browseAll(query = "") {
    const rows = this.db
      .prepare(
        `SELECT m.path, m.name, m.description, m.licence, m.diagnostic,
        s.id AS source_id, s.owner, s.repository, g.id AS generation_id, g.commit_id
        FROM skill_sources s JOIN source_generations g ON g.id = s.current_generation_id
        JOIN source_manifests m ON m.generation_id = g.id
        WHERE s.enabled = 1 AND g.state = 'complete' AND m.indexed = 1
        AND instr(lower(COALESCE(m.name,'') || ' ' || COALESCE(m.description,'') || ' ' || m.path), lower(?)) > 0
        ORDER BY COALESCE(m.name, m.path), s.owner, s.repository LIMIT 10000`,
      )
      .all(query);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE source_generations SET last_accessed_at = ? WHERE id IN (SELECT current_generation_id FROM skill_sources WHERE enabled = 1 AND current_generation_id IS NOT NULL)",
      )
      .run(now);
    return { skills: rows };
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
    this.live.close();
    this.job?.controller.abort();
    await this.job?.promise;
  }
  private async response(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    options?: { revalidate?: boolean },
  ): Promise<Response> {
    return this.github.request(url, headers, signal, options);
  }
  private async boundedJson(
    response: Response,
    maximum = 1024 * 1024,
  ): Promise<unknown> {
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
        if (size > maximum)
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

  private throwGitHubError(response: Response, sourceId: string): never {
    if (response.status === 401 && this.enabledToken())
      throw new SkillError(
        "token_rejected",
        401,
        "Token rejected by GitHub. Check that it hasn't expired.",
      );
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
      this.db
        .prepare("UPDATE skill_sources SET rate_limit_reset = ? WHERE id = ?")
        .run(resetAt, sourceId);
      const retry = resetAt
        ? `; try again after ${new Date(resetAt).toLocaleTimeString()}, or enable a token`
        : "; try again later, or enable a token";
      throw new SkillError(
        "source_rate_limited",
        429,
        `GitHub rate limit reached${retry}`,
      );
    }
    throw new SkillError(
      "source_error",
      502,
      `GitHub request failed (${response.status})`,
    );
  }

  async packageFiles(
    id: string,
    generationId: string,
    manifestPath: string,
  ): Promise<{
    files: SkillFile[];
    provenance: Record<string, unknown>;
    licence: string | null;
    diagnostic: string | null;
  }> {
    const source = this.source(id);
    const generation = this.db
      .prepare(
        "SELECT commit_id FROM source_generations WHERE id = ? AND source_id = ? AND state = 'complete'",
      )
      .get(generationId, id) as { commit_id: string } | undefined;
    const manifest = this.db
      .prepare(
        "SELECT licence, diagnostic FROM source_manifests WHERE generation_id = ? AND path = ? AND indexed = 1",
      )
      .get(generationId, manifestPath) as
      { licence: string | null; diagnostic: string | null } | undefined;
    if (!generation || !manifest)
      throw new SkillError(
        "source_unavailable",
        404,
        "Cached skill unavailable",
      );
    const cachedPackage = this.db
      .prepare(
        "SELECT licence_path FROM source_cached_packages WHERE generation_id = ? AND manifest_path = ?",
      )
      .get(generationId, manifestPath) as
      { licence_path: string | null } | undefined;
    if (cachedPackage) {
      const files = this.db
        .prepare(
          `SELECT f.path, f.mode, b.content FROM source_cached_files f
          JOIN source_cached_blobs b ON b.sha = f.sha
          WHERE f.generation_id = ? AND f.manifest_path = ? ORDER BY f.path`,
        )
        .all(generationId, manifestPath) as SkillFile[];
      this.db
        .prepare(
          "UPDATE source_cached_packages SET last_accessed_at = ? WHERE generation_id = ? AND manifest_path = ?",
        )
        .run(this.now(), generationId, manifestPath);
      return {
        files,
        provenance: {
          source: `${source.owner}/${source.repository}`,
          commit: generation.commit_id,
          path: manifestPath,
          licence_path: cachedPackage.licence_path,
        },
        licence: manifest.licence,
        diagnostic: manifest.diagnostic,
      };
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
    ]);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Konfab",
    };
    const token = this.enabledToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const treeItems: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string;
      size?: number;
    }> = [];
    let requests = 0;
    const getTree = async (sha: string, prefix: string, recursive: boolean) => {
      if (++requests > 200)
        throw new SkillError("source_limit", 413, "Source tree is too large");
      const response = await this.response(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`,
        headers,
        signal,
      );
      if (!response.ok) this.throwGitHubError(response, source.id);
      const payload = (await this.boundedJson(response, 10 * 1024 * 1024)) as {
        truncated?: boolean;
        tree?: Array<{
          path?: unknown;
          mode?: unknown;
          type?: unknown;
          sha?: unknown;
          size?: unknown;
        }>;
      };
      if (!Array.isArray(payload.tree))
        throw new SkillError("source_error", 502, "Invalid source tree");
      if (recursive && payload.truncated) {
        await getTree(sha, prefix, false);
        return;
      }
      if (!recursive && payload.truncated)
        throw new SkillError("source_limit", 413, "Source tree is truncated");
      for (const raw of payload.tree) {
        if (
          typeof raw.path !== "string" ||
          typeof raw.mode !== "string" ||
          typeof raw.type !== "string" ||
          typeof raw.sha !== "string"
        )
          throw new SkillError(
            "source_error",
            502,
            "Invalid source tree entry",
          );
        const path = prefix ? `${prefix}/${raw.path}` : raw.path;
        if (raw.type === "tree" && !recursive) {
          await getTree(raw.sha, path, false);
        } else if (raw.type === "blob") {
          treeItems.push({
            path,
            mode: raw.mode,
            type: raw.type,
            sha: raw.sha,
            ...(typeof raw.size === "number" ? { size: raw.size } : {}),
          });
          if (treeItems.length > 100_000)
            throw new SkillError(
              "source_limit",
              413,
              "Source tree is too large",
            );
        }
      }
    };
    await getTree(generation.commit_id, "", true);
    const packagePrefix = manifestPath.slice(0, -"SKILL.md".length);
    const nestedPrefixes = treeItems
      .filter(
        (item) =>
          item.path !== manifestPath &&
          item.path.startsWith(packagePrefix) &&
          item.path.endsWith("/SKILL.md"),
      )
      .map((item) => item.path.slice(0, -"SKILL.md".length));
    const candidates = treeItems.filter(
      (item) =>
        item.path.startsWith(packagePrefix) &&
        !nestedPrefixes.some((prefix) => item.path.startsWith(prefix)),
    );
    const expected = new Map<
      string,
      { path: string; sha: string; mode: number }
    >();
    const addExpected = (
      item: (typeof treeItems)[number],
      relativeOverride?: string,
    ) => {
      if (item.mode === "120000")
        throw new SkillError("invalid_path", 400, "Links are not allowed");
      const relative =
        relativeOverride ?? item.path.slice(packagePrefix.length);
      if (
        !relative ||
        relative.startsWith("/") ||
        /[\\\0]/.test(relative) ||
        relative
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new SkillError("invalid_path", 400, "Invalid package path");
      if (expected.size >= 1000 || (item.size ?? 0) > 512 * 1024)
        throw new SkillError("package_limits", 413, "Package exceeds limits");
      const mode = item.mode === "100755" ? 0o700 : 0o600;
      expected.set(item.path, { path: relative, sha: item.sha, mode });
    };
    for (const item of candidates) addExpected(item);

    const ancestors = packagePrefix.replace(/\/$/, "").split("/");
    let licenceItem: (typeof treeItems)[number] | undefined;
    for (let depth = ancestors.length; depth >= 0 && !licenceItem; depth -= 1) {
      const prefix = ancestors.slice(0, depth).join("/");
      licenceItem = treeItems.find((item) => {
        const parent = item.path.includes("/")
          ? item.path.slice(0, item.path.lastIndexOf("/"))
          : "";
        const base = item.path.split("/").at(-1) ?? "";
        return parent === prefix && /^licen[cs]e(?:[._-].*)?$/i.test(base);
      });
    }
    let licencePath: string | null = null;
    if (
      licenceItem &&
      !candidates.some((item) => item.path === licenceItem?.path)
    ) {
      addExpected(licenceItem, "SOURCE-LICENSE");
      licencePath = licenceItem.path;
    } else if (licenceItem) {
      licencePath = licenceItem.path;
    }
    const archive = await this.response(
      `https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/tar.gz/${generation.commit_id}`,
      { "User-Agent": "Konfab" },
      signal,
    );
    if (!archive.ok || !archive.body)
      throw new SkillError(
        "source_error",
        502,
        "Unable to download pinned source archive",
      );
    const files = await extractVerifiedPackage(
      Readable.fromWeb(archive.body as unknown as NodeReadableStream),
      expected,
      signal,
    );
    if (!files.some((file) => file.path === "SKILL.md"))
      throw new SkillError("skill_missing", 404, "Source manifest missing");
    const cacheFiles = new Map(
      [...expected.values()].map((item) => [item.path, item]),
    );
    const cacheBytes = files.reduce(
      (sum, file) =>
        sum + file.content.length + Buffer.byteLength(file.path) + 128,
      0,
    );
    this.db.transaction(() => {
      let used =
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_generations WHERE state = 'complete'",
            )
            .get() as { n: number }
        ).n +
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_cached_packages",
            )
            .get() as { n: number }
        ).n;
      const old = this.db
        .prepare(
          "SELECT generation_id, manifest_path, cache_bytes FROM source_cached_packages ORDER BY last_accessed_at",
        )
        .all() as Array<{
        generation_id: string;
        manifest_path: string;
        cache_bytes: number;
      }>;
      for (const row of old) {
        if (used + cacheBytes <= this.cacheBytes) break;
        this.db
          .prepare(
            "DELETE FROM source_cached_packages WHERE generation_id = ? AND manifest_path = ?",
          )
          .run(row.generation_id, row.manifest_path);
        used -= row.cache_bytes;
      }
      this.db
        .prepare(
          "DELETE FROM source_cached_blobs WHERE sha NOT IN (SELECT sha FROM source_cached_files)",
        )
        .run();
      if (used + cacheBytes > this.cacheBytes) return;
      this.db
        .prepare(
          "INSERT INTO source_cached_packages(generation_id, manifest_path, licence_path, cache_bytes, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(generationId, manifestPath, licencePath, cacheBytes, this.now());
      const blobInsert = this.db.prepare(
        "INSERT OR IGNORE INTO source_cached_blobs(sha, content) VALUES (?, ?)",
      );
      const fileInsert = this.db.prepare(
        "INSERT INTO source_cached_files(generation_id, manifest_path, path, sha, mode) VALUES (?, ?, ?, ?, ?)",
      );
      for (const file of files) {
        const cached = cacheFiles.get(file.path)!;
        blobInsert.run(cached.sha, file.content);
        fileInsert.run(
          generationId,
          manifestPath,
          cached.path,
          cached.sha,
          cached.mode,
        );
      }
    })();
    return {
      files,
      provenance: {
        source: `${source.owner}/${source.repository}`,
        commit: generation.commit_id,
        path: manifestPath,
        licence_path: licencePath,
      },
      licence: manifest.licence,
      diagnostic: manifest.diagnostic,
    };
  }
  private async refresh(source: Source, signal: AbortSignal): Promise<void> {
    let generation: string | null = null;
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Konfab",
      };
      const token = this.enabledToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (source.etag && source.current_generation_id)
        headers["If-None-Match"] = source.etag;
      const api = await this.response(
        `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/commits/${encodeURIComponent(source.ref)}`,
        headers,
        signal,
        { revalidate: true },
      );
      if (api.headers.get("x-konfab-stale") === "1") {
        const resetAt = Number(api.headers.get("x-konfab-reset"));
        this.db
          .prepare("UPDATE skill_sources SET rate_limit_reset = ? WHERE id = ?")
          .run(resetAt, source.id);
        const time = new Date(resetAt).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        throw new SkillError(
          "source_rate_limited",
          429,
          `GitHub limit reached; resets at ${time}. Add a token for more.`,
        );
      }
      if (api.status === 304) {
        this.db
          .prepare(
            "UPDATE skill_sources SET last_checked_at = ?, rate_limit_reset = NULL WHERE id = ?",
          )
          .run(this.now(), source.id);
        return;
      }
      if (!api.ok) this.throwGitHubError(api, source.id);
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
        ).n +
        (
          this.db
            .prepare(
              "SELECT COALESCE(SUM(cache_bytes),0) AS n FROM source_cached_packages",
            )
            .get() as { n: number }
        ).n +
        incoming.cache_bytes;
      const evictable = this.db
        .prepare(
          `SELECT g.id, g.cache_bytes + COALESCE((SELECT SUM(p.cache_bytes) FROM source_cached_packages p WHERE p.generation_id = g.id), 0) AS cache_bytes
          FROM source_generations g WHERE g.state = 'complete' AND g.id NOT IN
          (SELECT current_generation_id FROM skill_sources WHERE current_generation_id IS NOT NULL AND id != ? AND enabled = 1)
          ORDER BY g.last_accessed_at`,
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
          "DELETE FROM source_cached_blobs WHERE sha NOT IN (SELECT sha FROM source_cached_files)",
        )
        .run();
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
