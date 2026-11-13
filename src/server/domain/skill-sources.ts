import type { TokenSource } from "../github-token.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
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

export type SourceOptions = {
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
  private readonly token: string | undefined;
  private readonly tokenSource: TokenSource;
  private readonly notify: () => void;
  constructor(
    private readonly db: Db,
    options: SourceOptions = {},
  ) {
    this.github = new GitHubClient(
      options.fetch ?? fetch,
      options.now ?? Date.now,
    );
    this.now = options.now ?? Date.now;
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
    rate_limit_reset: number | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, owner, repository, ref, badge, enabled, rate_limit_reset FROM skill_sources ORDER BY enabled DESC, owner, repository",
      )
      .all() as ReturnType<SkillSources["list"]>;
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

  async close(): Promise<void> {
    this.live.close();
  }
}
