import { parseDocument } from "yaml";
import { createHash } from "node:crypto";
import type { SkillFile } from "./skill-files.js";
import type { GitHubClient } from "./github-client.js";
import { SkillError } from "./skill-error.js";

type Source = {
  id: string;
  owner: string;
  repository: string;
  ref: string;
  badge: string;
  enabled: number;
};
type Item = {
  source_id: string;
  source: string;
  badge: string;
  commit: string;
  path: string;
  name: string;
  description: string | null;
  licence: string | null;
  diagnostic: string | null;
};
type TreeItem = {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
};
type State = {
  source: Source;
  commit: string;
  tree: TreeItem[];
  items: Item[];
  done: number;
  listed: boolean;
  complete: boolean;
  error: string | null;
  expires: number;
  controller: AbortController;
};

/** Public browse data is bounded and kept only in this process, never in the library database. */
export class LiveSources {
  private readonly states = new Map<string, State>();
  private readonly allocations = new Map<string, number>();
  private rawLimitedUntil = 0;
  constructor(
    private readonly client: GitHubClient,
    private readonly sources: () => Source[],
    private readonly token: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}
  private headers(): Record<string, string> {
    const token = this.token();
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": "Konfab",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }
  private safePath(path: string): boolean {
    return (
      path.length <= 1024 &&
      !path.startsWith("/") &&
      !/[\\\\\0]/.test(path) &&
      path.split("/").every((p) => p && p !== "." && p !== "..")
    );
  }
  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.client.request(url, this.headers(), signal);
    if (response.status === 401 && this.token())
      throw new SkillError(
        "token_rejected",
        401,
        "Token rejected by GitHub. Check that it hasn't expired.",
      );
    if (!response.ok)
      throw new SkillError(
        "source_error",
        response.status === 429 || response.status === 403 ? 429 : 502,
        `Public source request failed (${response.status}); try again later or enable a token.`,
      );
    return response.json();
  }
  private rawUrl(source: Source, commit: string, path: string): string {
    return `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  start(): void {
    const now = this.now();
    for (const [id, state] of this.states)
      if (
        state.expires <= now ||
        !this.sources().some((s) => s.id === id && s.enabled)
      ) {
        state.controller.abort();
        this.states.delete(id);
        this.allocations.delete(id);
      }
    for (const source of this.sources()
      .filter((s) => s.enabled)
      .slice(0, 20)) {
      if (this.states.has(source.id)) continue;
      const state: State = {
        source,
        commit: "",
        tree: [],
        items: [],
        done: 0,
        listed: false,
        complete: false,
        error: null,
        expires: now + 15 * 60_000,
        controller: new AbortController(),
      };
      this.states.set(source.id, state);
      void this.load(state);
    }
  }
  private async load(state: State): Promise<void> {
    const { source, controller } = state;
    const prefix = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
    try {
      const commit = (await this.json(
        `${prefix}/commits/${encodeURIComponent(source.ref)}`,
        controller.signal,
      )) as { sha?: unknown };
      if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/i.test(commit.sha))
        throw new Error("Invalid commit returned by source");
      state.commit = commit.sha.toLowerCase();
      const tree = (await this.json(
        `${prefix}/git/trees/${state.commit}?recursive=1`,
        controller.signal,
      )) as { tree?: TreeItem[]; truncated?: boolean };
      if (!Array.isArray(tree.tree) || tree.truncated)
        throw new Error("Source listing is incomplete; try again later.");
      if (tree.tree.length > 30_000)
        throw new Error("Source listing exceeds the temporary limit.");
      const estimate =
        Buffer.byteLength(JSON.stringify(tree.tree)) * 2 +
        tree.tree.filter(
          (entry) =>
            typeof entry.path === "string" && entry.path.endsWith("SKILL.md"),
        ).length *
          2048;
      const allocated = [...this.allocations.values()].reduce(
        (sum, bytes) => sum + bytes,
        0,
      );
      if (allocated + estimate > 16 * 1024 * 1024)
        throw new Error(
          "Temporary search memory limit reached; disable a source and try again.",
        );
      this.allocations.set(source.id, estimate);
      state.tree = tree.tree.filter(
        (entry) => typeof entry.path === "string" && this.safePath(entry.path),
      );
      const candidateCount = state.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.mode !== "120000" &&
          entry.path.split("/").at(-1) === "SKILL.md",
      ).length;
      if (candidateCount > 2000)
        state.error =
          "Only the first 2,000 skills are shown; this source is incomplete.";
      state.items = state.tree
        .filter(
          (entry) =>
            entry.type === "blob" &&
            entry.mode !== "120000" &&
            entry.path.split("/").at(-1) === "SKILL.md",
        )
        .slice(0, 2000)
        .map((entry) => ({
          source_id: source.id,
          source: `${source.owner}/${source.repository}`,
          badge: source.badge,
          commit: state.commit,
          path: entry.path,
          name: entry.path.split("/").at(-2) ?? "skill",
          description: null,
          licence: null,
          diagnostic: null,
        }));
      state.listed = true;
      await this.loadDescriptions(state);
    } catch (error) {
      if (!controller.signal.aborted)
        state.error =
          error instanceof Error ? error.message : "Source unavailable";
    } finally {
      state.complete = true;
    }
  }
  private async loadDescriptions(state: State): Promise<void> {
    const { source, controller } = state;
    let index = 0;
    const pending = state.items.filter(
      (item) => item.description === null && item.diagnostic === null,
    );
    const worker = async () => {
      while (!controller.signal.aborted && this.rawLimitedUntil <= this.now()) {
        const item = pending[index++];
        if (!item) return;
        let counted = true;
        try {
          const response = await this.client.request(
            this.rawUrl(source, state.commit, item.path),
            { "User-Agent": "Konfab" },
            controller.signal,
          );
          if (response.status === 403 || response.status === 429) {
            const retry = Number(response.headers.get("retry-after"));
            this.rawLimitedUntil =
              this.now() +
              (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000);
            state.error =
              "Public description requests are limited; showing partial results. Try again later.";
            counted = false;
            return;
          }
          if (!response.ok)
            throw new Error(`Description unavailable (${response.status})`);
          const text = await response.text();
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
          if (!match?.[1]) throw new Error("Missing frontmatter");
          const doc = parseDocument(match[1], {
            uniqueKeys: true,
            customTags: [],
          });
          if (doc.errors.length) throw new Error("Invalid frontmatter");
          const value: unknown = doc.toJS({ maxAliasCount: 0 });
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Invalid frontmatter");
          const meta = value as Record<string, unknown>;
          if (typeof meta.name === "string")
            item.name = meta.name.slice(0, 256);
          if (typeof meta.description === "string")
            item.description = meta.description.slice(0, 1024);
          else item.diagnostic = "Description unavailable";
          if (typeof meta.license === "string")
            item.licence = meta.license.slice(0, 256);
        } catch (error) {
          item.diagnostic =
            error instanceof Error ? error.message : "Description unavailable";
        } finally {
          if (counted) state.done++;
        }
      }
    };
    await Promise.all(Array.from({ length: 2 }, () => worker()));
    if (
      this.rawLimitedUntil > this.now() &&
      state.done < state.items.length &&
      !state.error
    )
      state.error =
        "Public description requests are limited; showing partial results. Try again later.";
  }
  search(query: string) {
    this.start();
    const q = query.toLowerCase();
    const states = [...this.states.values()];
    for (const state of states) {
      if (
        state.complete &&
        state.done < state.items.length &&
        state.error?.startsWith("Public description requests are limited") &&
        this.rawLimitedUntil <= this.now()
      ) {
        state.complete = false;
        state.error = null;
        void this.loadDescriptions(state).finally(() => {
          state.complete = true;
        });
      }
    }
    const rank = (item: Item) => {
      const name = item.name.toLowerCase();
      const path = item.path.toLowerCase();
      if (q && name === q) return 0;
      if (q && name.startsWith(q)) return 1;
      if (q && (name.includes(q) || path.includes(q))) return 2;
      return 3;
    };
    return {
      items: states
        .flatMap((state) =>
          state.items.filter((item) =>
            `${item.path} ${item.name} ${item.description ?? ""}`
              .toLowerCase()
              .includes(q),
          ),
        )
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            a.source.localeCompare(b.source) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 200),
      sources: states.map((state) => ({
        source: `${state.source.owner}/${state.source.repository}`,
        done: state.done,
        total: state.items.length,
        complete: state.complete,
        stage: state.complete
          ? state.error
            ? "error"
            : "done"
          : state.listed
            ? "descriptions"
            : "listing",
        error: state.error,
      })),
    };
  }
  private packageEntries(
    state: State,
    path: string,
  ): Array<{ entry: TreeItem; relative: string }> {
    const prefix = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/") + 1)
      : "";
    const nested = state.tree
      .filter(
        (item) =>
          item.type === "blob" &&
          item.path.endsWith("/SKILL.md") &&
          item.path !== path &&
          item.path.startsWith(prefix),
      )
      .map((item) => item.path.slice(0, item.path.lastIndexOf("/") + 1));
    const entries = state.tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.startsWith(prefix) &&
          !nested.some((root) => entry.path.startsWith(root)),
      )
      .map((entry) => ({ entry, relative: entry.path.slice(prefix.length) }));
    const ancestors = prefix.replace(/\/$/, "").split("/").filter(Boolean);
    let licence: TreeItem | undefined;
    for (let depth = ancestors.length; depth >= 0 && !licence; depth--) {
      const parent = ancestors.slice(0, depth).join("/");
      licence = state.tree.find(
        (entry) =>
          entry.type === "blob" &&
          (entry.path.includes("/")
            ? entry.path.slice(0, entry.path.lastIndexOf("/"))
            : "") === parent &&
          /^licen[cs]e(?:[._-].*)?$/i.test(entry.path.split("/").at(-1) ?? ""),
      );
    }
    if (licence && !entries.some((item) => item.entry.path === licence!.path))
      entries.push({ entry: licence, relative: "SOURCE-LICENSE" });
    return entries;
  }
  async preview(sourceId: string, commit: string, path: string) {
    const state = this.states.get(sourceId);
    if (
      !state ||
      state.expires <= this.now() ||
      state.commit !== commit ||
      !this.sources().some(
        (source) => source.id === sourceId && source.enabled,
      ) ||
      !this.safePath(path)
    )
      throw new SkillError(
        "source_unavailable",
        409,
        "Preview expired; search again.",
      );
    const item = state.items.find((entry) => entry.path === path);
    if (!item) throw new SkillError("skill_missing", 404, "Skill not found");
    const response = await this.client.request(
      this.rawUrl(state.source, commit, path),
      { "User-Agent": "Konfab" },
      state.controller.signal,
    );
    if (!response.ok)
      throw new SkillError(
        "source_error",
        502,
        "Unable to load the skill preview",
      );
    const files = this.packageEntries(state, path).map(
      ({ entry, relative }) => ({
        path: relative,
        size: entry.size ?? 0,
        mode: entry.mode,
      }),
    );
    const content = await response.text();
    return {
      ...item,
      licence:
        item.licence ??
        (files.some((file) => file.path === "SOURCE-LICENSE")
          ? "See SOURCE-LICENSE (repository licence)"
          : null),
      content,
      preview_hash: createHash("sha256").update(content).digest("hex"),
      files,
    };
  }
  async previewFile(
    sourceId: string,
    commit: string,
    path: string,
    relative: string,
  ): Promise<string> {
    await this.preview(sourceId, commit, path);
    const state = this.states.get(sourceId)!;
    const selected = this.packageEntries(state, path).find(
      (item) => item.relative === relative,
    );
    if (
      !selected ||
      !["100644", "100755"].includes(selected.entry.mode) ||
      !/^[a-f0-9]{40}$/i.test(selected.entry.sha)
    )
      throw new SkillError(
        "invalid_path",
        400,
        "File unavailable in this skill preview",
      );
    const response = await this.client.request(
      this.rawUrl(state.source, commit, selected.entry.path),
      { "User-Agent": "Konfab" },
      state.controller.signal,
    );
    if (!response.ok)
      throw new SkillError("source_error", 502, "Unable to load preview file");
    const content = Buffer.from(await response.arrayBuffer());
    if (
      createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex") !== selected.entry.sha.toLowerCase()
    )
      throw new SkillError(
        "source_changed",
        409,
        "Source file changed; search again.",
      );
    return content.toString("base64");
  }
  async packageFiles(
    sourceId: string,
    commit: string,
    path: string,
    previewHash: string,
  ): Promise<{
    files: SkillFile[];
    licence: string | null;
    provenance: Record<string, unknown>;
  }> {
    const state = this.states.get(sourceId);
    const preview = await this.preview(sourceId, commit, path);
    if (
      !state ||
      createHash("sha256").update(preview.content).digest("hex") !== previewHash
    )
      throw new SkillError(
        "source_changed",
        409,
        "Preview changed; review it again.",
      );
    const entries = this.packageEntries(state, path);
    if (new Set(entries.map((item) => item.relative)).size !== entries.length)
      throw new SkillError(
        "invalid_path",
        400,
        "Skill and source licence paths conflict.",
      );
    if (
      !entries.length ||
      entries.length > 1000 ||
      entries.some(
        ({ entry }) =>
          !["100644", "100755"].includes(entry.mode) ||
          !/^[a-f0-9]{40}$/i.test(entry.sha) ||
          (entry.size ?? 0) > 512 * 1024,
      )
    )
      throw new SkillError(
        "package_limits",
        413,
        "Skill files exceed limits or contain an unsupported link.",
      );
    const files: SkillFile[] = [];
    let total = 0;
    for (const { entry, relative } of entries) {
      const response = await this.client.request(
        this.rawUrl(state.source, commit, entry.path),
        { "User-Agent": "Konfab" },
        state.controller.signal,
      );
      if (!response.ok)
        throw new SkillError(
          "source_error",
          502,
          "Unable to fetch a skill file",
        );
      const content = Buffer.from(await response.arrayBuffer());
      total += content.length;
      if (total > 10 * 1024 * 1024)
        throw new SkillError(
          "package_limits",
          413,
          "Skill files exceed size limit",
        );
      const actual = createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      if (actual !== entry.sha.toLowerCase())
        throw new SkillError(
          "source_changed",
          409,
          "Source file changed; review again.",
        );
      files.push({
        path: relative,
        content,
        mode: entry.mode === "100755" ? 0o700 : 0o600,
      });
    }
    return {
      files,
      licence: preview.licence,
      provenance: { source: preview.source, commit, path },
    };
  }
  close(): void {
    for (const state of this.states.values()) state.controller.abort();
    this.states.clear();
    this.allocations.clear();
  }
}
