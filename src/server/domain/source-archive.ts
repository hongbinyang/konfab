import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { SkillError } from "./skill-error.js";

const MIB = 1024 * 1024;
export interface ArchiveEntry {
  path: string;
  size: number;
  kind: "file" | "directory" | "skipped";
  manifest?: Buffer | null;
}
export interface ArchiveLimits {
  compressed: number;
  expanded: number;
  entries: number;
  manifests: number;
  depth: number;
}
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  compressed: 50 * MIB,
  expanded: 100 * MIB,
  entries: 100_000,
  manifests: 10_000,
  depth: 32,
};

export async function indexArchive(
  input: Readable,
  onEntry: (entry: ArchiveEntry) => void,
  limits = DEFAULT_ARCHIVE_LIMITS,
  signal?: AbortSignal,
): Promise<void> {
  let compressed = 0,
    expanded = 0,
    count = 0,
    manifests = 0;
  let root: string | null = null;
  const seen = new Set<string>();
  const bounded = (maximum: number, update: (size: number) => number) =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const size = update(chunk.length);
        callback(
          size > maximum
            ? new SkillError(
                "source_limit",
                413,
                "Source archive exceeds its size limit",
              )
            : null,
          chunk,
        );
      },
    });
  const compressedCounter = bounded(
    limits.compressed,
    (n) => (compressed += n),
  );
  const expandedCounter = bounded(limits.expanded, (n) => (expanded += n));
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    try {
      count += 1;
      if (count > limits.entries)
        throw new SkillError(
          "source_limit",
          413,
          "Source archive has too many entries",
        );
      const raw = header.name.replace(/\/$/, "");
      const parts = raw.split("/");
      if (
        !raw ||
        raw.startsWith("/") ||
        /[\\\0]/.test(raw) ||
        parts.some((part) => !part || part === "." || part === "..") ||
        parts.length > limits.depth + 1 ||
        Buffer.byteLength(raw) > 1024
      )
        throw new SkillError(
          "invalid_source",
          400,
          "Source archive has an invalid path",
        );
      root ??= parts[0]!;
      if (parts[0] !== root)
        throw new SkillError(
          "invalid_source",
          400,
          "Source archive has multiple roots",
        );
      const path = parts.slice(1).join("/");
      if (!path) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      if (seen.has(path))
        throw new SkillError(
          "invalid_source",
          400,
          "Source archive has duplicate paths",
        );
      seen.add(path);
      const kind =
        header.type === "file"
          ? "file"
          : header.type === "directory"
            ? "directory"
            : "skipped";
      const isManifest =
        kind === "file" && (path === "SKILL.md" || path.endsWith("/SKILL.md"));
      if (isManifest && ++manifests > limits.manifests)
        throw new SkillError(
          "source_limit",
          413,
          "Source has too many skill manifests",
        );
      let size = 0,
        tooLarge = false;
      const chunks: Buffer[] = [];
      stream.on("data", (data: unknown) => {
        const chunk = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as Uint8Array);
        size += chunk.length;
        if (isManifest) {
          if (size <= 512 * 1024) chunks.push(chunk);
          else {
            tooLarge = true;
            chunks.length = 0;
          }
        }
      });
      stream.on("error", (error) => tar.destroy(error));
      stream.on("end", () => {
        try {
          onEntry({
            path,
            size,
            kind,
            ...(isManifest
              ? { manifest: tooLarge ? null : Buffer.concat(chunks) }
              : {}),
          });
          next();
        } catch (error) {
          tar.destroy(error as Error);
        }
      });
      stream.resume();
    } catch (error) {
      stream.resume();
      tar.destroy(error as Error);
    }
  });
  await pipeline(
    input,
    compressedCounter,
    createGunzip(),
    expandedCounter,
    tar,
    { signal },
  );
  if (!root)
    throw new SkillError("invalid_source", 400, "Source archive is empty");
}

export async function extractVerifiedPackage(
  input: Readable,
  expected: Map<string, { path: string; sha: string; mode: number }>,
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: Buffer; mode: number }>> {
  if (expected.size > 1000)
    throw new SkillError("package_limits", 413, "Package exceeds limits");
  let compressed = 0,
    expanded = 0,
    entries = 0,
    selectedBytes = 0;
  let root: string | null = null;
  const files: Array<{ path: string; content: Buffer; mode: number }> = [];
  const found = new Set<string>();
  const counter = (maximum: number, update: (size: number) => number) =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        callback(
          update(chunk.length) > maximum
            ? new SkillError(
                "source_limit",
                413,
                "Source archive exceeds its size limit",
              )
            : null,
          chunk,
        );
      },
    });
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    try {
      entries += 1;
      if (entries > DEFAULT_ARCHIVE_LIMITS.entries)
        throw new SkillError(
          "source_limit",
          413,
          "Source archive has too many entries",
        );
      const raw = header.name.replace(/\/$/, "");
      const parts = raw.split("/");
      if (
        !raw ||
        raw.startsWith("/") ||
        /[\\\0]/.test(raw) ||
        parts.some((part) => !part || part === "." || part === "..") ||
        parts.length > DEFAULT_ARCHIVE_LIMITS.depth + 1 ||
        Buffer.byteLength(raw) > 1024
      )
        throw new SkillError(
          "invalid_source",
          400,
          "Source archive has an invalid path",
        );
      root ??= parts[0]!;
      if (parts[0] !== root)
        throw new SkillError(
          "invalid_source",
          400,
          "Source archive has multiple roots",
        );
      const repositoryPath = parts.slice(1).join("/");
      const wanted = expected.get(repositoryPath);
      if (!wanted) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      if (header.type !== "file" || found.has(repositoryPath))
        throw new SkillError("invalid_source", 400, "Invalid package entry");
      found.add(repositoryPath);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (data: unknown) => {
        const chunk = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as Uint8Array);
        size += chunk.length;
        selectedBytes += chunk.length;
        if (size > 512 * 1024 || selectedBytes > 2 * 1024 * 1024)
          tar.destroy(
            new SkillError("package_limits", 413, "Package exceeds limits"),
          );
        else chunks.push(chunk);
      });
      stream.on("error", (error) => tar.destroy(error));
      stream.on("end", () => {
        try {
          const content = Buffer.concat(chunks);
          const actual = createHash("sha1")
            .update(`blob ${content.length}\0`)
            .update(content)
            .digest("hex");
          if (actual !== wanted.sha)
            throw new SkillError(
              "source_hash",
              502,
              "Source file hash mismatch",
            );
          files.push({
            path: wanted.path,
            content,
            mode: wanted.mode,
          });
          next();
        } catch (error) {
          tar.destroy(error as Error);
        }
      });
      stream.resume();
    } catch (error) {
      stream.resume();
      tar.destroy(error as Error);
    }
  });
  await pipeline(
    input,
    counter(DEFAULT_ARCHIVE_LIMITS.compressed, (n) => (compressed += n)),
    createGunzip(),
    counter(DEFAULT_ARCHIVE_LIMITS.expanded, (n) => (expanded += n)),
    tar,
    { signal },
  );
  if (found.size !== expected.size)
    throw new SkillError(
      "source_unavailable",
      502,
      "Pinned source archive is incomplete",
    );
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
