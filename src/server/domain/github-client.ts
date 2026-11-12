import { SkillError } from "./skill-error.js";

type Entry = {
  body: Uint8Array;
  headers: [string, string][];
  status: number;
  expires: number;
  etag: string | null;
  size: number;
};

export type GitHubStatus = {
  state: "not_checked" | "accepted" | "rejected" | "unavailable";
  limit: number | null;
  remaining: number | null;
  reset_at: number | null;
  checked_at: number | null;
};
const unchecked = (): GitHubStatus => ({
  state: "not_checked",
  limit: null,
  remaining: null,
  reset_at: null,
  checked_at: null,
});

/** Bounded process-local GitHub response cache; credentials are never stored in keys. */
export class GitHubClient {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<
    string,
    { promise: Promise<Response>; controller: AbortController; users: number }
  >();
  private bytes = 0;
  private rawActive = 0;
  private readonly rawQueue: Array<() => void> = [];
  private budget = new Map<string, { remaining: number; reset: number }>();
  private readonly status = new Map<string, GitHubStatus>();
  statusFor(authenticated: boolean): GitHubStatus {
    return this.status.get(authenticated ? "auth" : "public") ?? unchecked();
  }

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  async request(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    options: { revalidate?: boolean } = {},
  ): Promise<Response> {
    if (signal.aborted) throw signal.reason;
    const parsed = new URL(url);
    const cacheable =
      parsed.hostname === "raw.githubusercontent.com" ||
      (parsed.hostname === "api.github.com" &&
        /\/(?:commits|git\/trees)\//.test(parsed.pathname));
    if (!cacheable) return this.requestLimited(url, headers, signal, options);
    const normalized = new Headers(headers);
    // This client has only one configured token; keep credentials out of map keys.
    const key = `${normalized.has("authorization") ? "auth" : "public"}:${url}:${options.revalidate ? "revalidate" : "normal"}:${normalized.get("accept") ?? ""}:${normalized.get("if-none-match") ?? ""}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      const controller = new AbortController();
      const promise = this.requestLimited(
        url,
        headers,
        controller.signal,
        options,
      );
      pending = { promise, controller, users: 0 };
      this.inflight.set(key, pending);
      void promise.then(
        () => {
          if (this.inflight.get(key)?.promise === promise)
            this.inflight.delete(key);
        },
        () => {
          if (this.inflight.get(key)?.promise === promise)
            this.inflight.delete(key);
        },
      );
    }
    pending.users++;
    const shared = pending;
    try {
      return await new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        shared.promise.then(
          (response) => {
            signal.removeEventListener("abort", abort);
            resolve(response.clone());
          },
          (error: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
        if (signal.aborted) abort();
      });
    } finally {
      shared.users--;
      if (!shared.users && this.inflight.get(key) === shared) {
        this.inflight.delete(key);
        shared.controller.abort();
      }
    }
  }

  private async requestLimited(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    options: { revalidate?: boolean },
  ): Promise<Response> {
    const isRaw = new URL(url).hostname === "raw.githubusercontent.com";
    if (!isRaw) return this.requestInner(url, headers, signal, options);
    if (this.rawActive >= 4)
      await new Promise<void>((resolve, reject) => {
        const run = () => {
          signal.removeEventListener("abort", abort);
          this.rawActive++;
          resolve();
        };
        const abort = () => {
          const index = this.rawQueue.indexOf(run);
          if (index >= 0) this.rawQueue.splice(index, 1);
          reject(signal.reason);
        };
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        this.rawQueue.push(run);
      });
    else this.rawActive++;
    try {
      return await this.requestInner(url, headers, signal, options);
    } finally {
      this.rawActive--;
      this.rawQueue.shift()?.();
    }
  }

  private async requestInner(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    options: { revalidate?: boolean },
  ): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ![
        "api.github.com",
        "raw.githubusercontent.com",
        "codeload.github.com",
      ].includes(parsed.hostname)
    )
      throw new SkillError("invalid_source", 400, "Source host is not allowed");
    const normalized = new Headers(headers);
    const authenticated = normalized.has("authorization");
    if (parsed.hostname !== "api.github.com" && authenticated)
      throw new SkillError(
        "invalid_source",
        400,
        "Credentials cannot be sent to this host",
      );
    const cacheable =
      parsed.hostname === "raw.githubusercontent.com" ||
      (parsed.hostname === "api.github.com" &&
        /\/(?:commits|git\/trees)\//.test(parsed.pathname));
    // The only secret-bearing scope is the configured opted-in credential; do not place it in a cache key.
    const key = `${authenticated ? "auth" : "public"}:${url}`;
    const existing = cacheable ? this.cache.get(key) : undefined;
    if (signal.aborted) throw signal.reason;
    if (existing && existing.expires > this.now() && !options.revalidate) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      return new Response(existing.body.slice(), {
        status: existing.status,
        headers: existing.headers,
      });
    }
    const limit = this.budget.get(authenticated ? "auth" : "public");
    if (
      parsed.hostname === "api.github.com" &&
      limit &&
      limit.remaining <= 1 &&
      limit.reset > this.now()
    ) {
      const time = new Date(limit.reset).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      if (existing) {
        const staleHeaders = new Headers(existing.headers);
        staleHeaders.set("x-konfab-stale", "1");
        staleHeaders.set("x-konfab-reset", String(limit.reset));
        return new Response(existing.body.slice(), {
          status: existing.status,
          headers: staleHeaders,
        });
      }
      throw new SkillError(
        "source_rate_limited",
        429,
        `GitHub limit reached; resets at ${time}. Add a token for more.`,
      );
    }
    if (existing?.etag) normalized.set("If-None-Match", existing.etag);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: normalized,
        redirect: "manual",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            parsed.hostname === "raw.githubusercontent.com" ? 15_000 : 120_000,
          ),
        ]),
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new SkillError(
        "source_unavailable",
        502,
        "GitHub request failed; try again later.",
      );
    }
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
    if (parsed.hostname === "api.github.com") {
      const numberHeader = (name: string): number | null => {
        const raw = response.headers.get(name);
        if (raw === null || !/^\d+$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) ? value : null;
      };
      const reset = numberHeader("x-ratelimit-reset");
      this.status.set(authenticated ? "auth" : "public", {
        state:
          response.status === 401 && authenticated
            ? "rejected"
            : response.ok || response.status === 304
              ? "accepted"
              : "unavailable",
        limit: numberHeader("x-ratelimit-limit"),
        remaining: numberHeader("x-ratelimit-remaining"),
        reset_at: reset === null ? null : reset * 1000,
        checked_at: this.now(),
      });
      const remaining = response.headers.get("x-ratelimit-remaining");
      const resetHeader = response.headers.get("x-ratelimit-reset");
      if (
        remaining !== null &&
        resetHeader !== null &&
        Number.isFinite(Number(remaining)) &&
        Number.isFinite(Number(resetHeader))
      )
        this.budget.set(authenticated ? "auth" : "public", {
          remaining: Number(remaining),
          reset: Number(resetHeader) * 1000,
        });
    }
    if (response.status === 304 && existing) {
      existing.expires = this.now() + 60 * 60 * 1000;
      return new Response(existing.body.slice(), {
        status: existing.status,
        headers: existing.headers,
      });
    }
    if (!cacheable || !response.ok || !response.body) return response;
    const maximum =
      parsed.hostname === "raw.githubusercontent.com"
        ? 512 * 1024
        : 10 * 1024 * 1024;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maximum) {
          await reader.cancel();
          throw new SkillError(
            "source_limit",
            413,
            "Source response exceeds its limit",
          );
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    const entry: Entry = {
      body,
      headers: [...response.headers.entries()],
      status: response.status,
      expires: this.now() + 60 * 60 * 1000,
      etag: response.headers.get("etag"),
      size: body.length,
    };
    if (existing) {
      this.bytes -= existing.size;
      this.cache.delete(key);
    }
    while (this.bytes + entry.size > this.maxBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value as string;
      this.bytes -= this.cache.get(oldest)!.size;
      this.cache.delete(oldest);
    }
    if (entry.size <= this.maxBytes) {
      this.cache.set(key, entry);
      this.bytes += entry.size;
    }
    return new Response(body.slice(), {
      status: response.status,
      headers: entry.headers,
    });
  }
}
