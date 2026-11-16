import { useEffect, useRef, useState } from "react";
import { RequestError, request } from "./api";

type Upload = {
  source_name: string;
  single_file: boolean;
  files: Array<{ path: string; content_base64: string }>;
};
type Collision =
  | null
  | {
      kind: "tracked";
      skill_id: string;
      number: number;
      revision_id: string;
      draft: boolean;
      draft_hash: string | null;
      used_by: string[];
      pending: PendingReason | null;
    }
  | { kind: "trashed" | "untracked" };
type Preview = {
  name: string;
  manifest_name: string | null;
  rename: { from: string; to: string } | null;
  description: string;
  licence: string | null;
  folder: string;
  skill_file: string | null;
  skill_file_candidates: string[];
  auto_chosen: boolean;
  destination_clash: string | null;
  broken_links: string[];
  missing_references: string[];
  manifest_text: string;
  files: Array<{ path: string; size: number }>;
  excluded: string[];
  errors: string[];
  builtin_name: boolean;
  collision: Collision;
  expected: {
    package_hash: string;
    collision_revision_id: string | null;
    collision_draft_hash: string | null;
  };
};
export type PendingReason = {
  code: "folder_exists" | "folder_edited" | "write_failed";
  folder: string;
  detail: string;
  target?: string | null;
};
type Result = {
  skill_id: string;
  number: number;
  folder: "ready" | "pending";
  pending_reason?: PendingReason;
};

/** Paths Konfab never imports; sent without contents so the preview can list them. */
const skipped = (path: string) =>
  path.split("/").includes(".git") || path.split("/").pop() === ".DS_Store";

function base64(bytes: ArrayBuffer): string {
  let text = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000)
    text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
}

async function readChosen(list: FileList, single: boolean): Promise<Upload> {
  const files = [...list];
  const first = files[0];
  const source = single
    ? (first?.name ?? "file")
    : first?.webkitRelativePath.split("/")[0] || "folder";
  return {
    source_name: source,
    single_file: single,
    files: await Promise.all(
      files.map(async (file) => {
        const path = single ? file.name : file.webkitRelativePath || file.name;
        return {
          path,
          content_base64: skipped(path) ? "" : base64(await file.arrayBuffer()),
        };
      }),
    ),
  };
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/** Explains a pending folder and offers the fixes that can resolve it. */
export function PendingFolder({
  skillId,
  reason,
  onResolved,
}: {
  skillId: string;
  reason: PendingReason;
  onResolved: (result: {
    folder: string;
    pending_reason?: PendingReason;
  }) => void;
}) {
  const [error, setError] = useState("");
  const act = async (action: "retry" | "move_aside" | "save_edits") => {
    try {
      onResolved(
        await request(`/api/library/skills/${skillId}/workspace/resolve`, {
          method: "POST",
          body: {
            action,
            expected_reason: reason.code,
            expected_target: reason.target ?? null,
          },
        }),
      );
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
      // The folder changed since this was shown: show what is there now, so
      // the lead decides again on the current state.
      if (e instanceof RequestError && e.code === "import_changed")
        try {
          onResolved(
            await request(`/api/library/skills/${skillId}/workspace/resolve`, {
              method: "POST",
              body: { action: "retry", expected_reason: reason.code },
            }),
          );
          setError(
            "The folder changed since this was shown. Here is what's there now; choose again.",
          );
        } catch {
          /* Keep the first message. */
        }
    }
  };
  return (
    <div className="import-box warn" role="alert">
      <p>{reason.detail} The saved revision is safe in History.</p>
      <div className="actions">
        {reason.code === "folder_exists" && (
          <button onClick={() => void act("move_aside")}>
            Move the other folder aside
          </button>
        )}
        {reason.code === "folder_edited" && (
          <>
            <button onClick={() => void act("save_edits")}>
              Save my edits first
            </button>
            <button onClick={() => void act("move_aside")}>
              Use the import, keep my edits aside
            </button>
          </>
        )}
        <button className="secondary" onClick={() => void act("retry")}>
          Retry
        </button>
      </div>
      {reason.code !== "write_failed" && (
        <p className="muted">
          Moved folders are listed under Kept copies, where you can look at them
          or remove them.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function LocalImport({
  context,
  onImported,
  onClose,
}: {
  context: { scope: "personal" | "project"; room_id?: number };
  onImported: (skillId: string) => void;
  onClose: () => void;
}) {
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [skillFile, setSkillFile] = useState<string | undefined>();
  const [leaveOut, setLeaveOut] = useState<string[]>([]);
  const [name, setName] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const body = () => ({
    ...context,
    ...(upload as Upload),
    ...(skillFile ? { skill_file: skillFile } : {}),
    leave_out: leaveOut,
    ...(name !== undefined ? { name } : {}),
  });

  useEffect(() => {
    if (!upload) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<Preview>("/api/library/import/preview", {
        method: "POST",
        body: body(),
        signal: controller.signal,
      })
        .then((next) => {
          setPreview(next);
          setError("");
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Preview failed");
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [upload, skillFile, leaveOut, name]);

  async function choose(list: FileList | null, single: boolean) {
    if (!list?.length) return;
    setPreview(null);
    setResult(null);
    setSkillFile(undefined);
    setLeaveOut([]);
    setName(undefined);
    setConfirmReplace(false);
    setUpload(await readChosen(list, single));
  }

  async function confirm(action: "create" | "replace") {
    if (!preview) return;
    setBusy(true);
    try {
      const next = await request<Result>("/api/library/import", {
        method: "POST",
        body: {
          ...body(),
          name: preview.name,
          action,
          expected: preview.expected,
        },
      });
      setResult(next);
      setError("");
      if (next.folder === "ready") onImported(next.skill_id);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Import failed";
      setError(message);
      // Anything stale is shown again for review.
      setName((current) => current);
      setLeaveOut((current) => [...current]);
    } finally {
      setBusy(false);
    }
  }

  const collision = preview?.collision ?? null;
  const ready =
    !!preview &&
    !preview.errors.length &&
    (collision === null || collision.kind === "tracked");

  return (
    <section className="local-import" aria-label="Import a skill">
      <h2>Import a skill</h2>
      <input
        ref={folderInput}
        type="file"
        hidden
        multiple
        aria-label="Choose folder"
        onChange={(e) => void choose(e.target.files, false)}
      />
      <input
        ref={fileInput}
        type="file"
        hidden
        aria-label="Choose file"
        onChange={(e) => void choose(e.target.files, true)}
      />
      <div className="actions">
        <button onClick={() => folderInput.current?.click()}>
          Choose folder…
        </button>
        <button onClick={() => fileInput.current?.click()}>Choose file…</button>
        <button className="secondary" onClick={onClose}>
          {result ? "Close" : "Cancel"}
        </button>
      </div>
      <p className="muted">
        Any file name works; Konfab saves the skill file as SKILL.md in a folder
        named after the skill. In the folder dialog, select the folder itself;
        the files inside are shown greyed out.
      </p>
      {result?.folder === "pending" && result.pending_reason && (
        <>
          <h3>
            Saved as rev {result.number}, but its folder isn't written yet
          </h3>
          <PendingFolder
            skillId={result.skill_id}
            reason={result.pending_reason}
            onResolved={(next) => {
              if (next.folder === "ready") onImported(result.skill_id);
              else
                setResult({ ...result, pending_reason: next.pending_reason });
            }}
          />
        </>
      )}
      {upload && preview && !result && (
        <>
          {!upload.single_file && (
            <p className="import-box warn">
              Your browser may leave out linked files and folders without
              telling Konfab. Check that this list has everything you expect.
            </p>
          )}
          <dl className="import-preview">
            <dt>Chosen</dt>
            <dd>
              <code>{upload.source_name}</code>{" "}
              <span className="muted">
                {upload.single_file
                  ? "(single file)"
                  : `(folder, ${preview.files.length} files)`}
              </span>
            </dd>
            <dt>Skill file</dt>
            <dd>
              {upload.single_file ||
              (preview.skill_file === "SKILL.md" &&
                !preview.skill_file_candidates.some(
                  (path) => path !== "SKILL.md",
                )) ? (
                <code>{preview.skill_file}</code>
              ) : (
                <select
                  aria-label="Skill file"
                  value={preview.skill_file ?? ""}
                  onChange={(e) => setSkillFile(e.target.value || undefined)}
                >
                  {!preview.skill_file && (
                    <option value="">Choose the skill file…</option>
                  )}
                  {[
                    ...preview.skill_file_candidates,
                    ...preview.files
                      .map((file) =>
                        file.path === "SKILL.md"
                          ? (preview.skill_file ?? "SKILL.md")
                          : file.path,
                      )
                      .filter(
                        (path) => !preview.skill_file_candidates.includes(path),
                      ),
                  ].map((path) => (
                    <option key={path} value={path}>
                      {path}
                      {preview.skill_file_candidates.includes(path)
                        ? " · looks like a skill file"
                        : ""}
                    </option>
                  ))}
                </select>
              )}
              {preview.skill_file && preview.skill_file !== "SKILL.md" && (
                <>
                  {" "}
                  → <code>SKILL.md</code>
                </>
              )}
              {preview.auto_chosen && (
                <div className="muted">
                  No SKILL.md here. Using {preview.skill_file}, the only file
                  with skill front matter. Change it if this is wrong.
                </div>
              )}
              {!preview.skill_file &&
                preview.skill_file_candidates.length > 1 && (
                  <div className="muted">
                    Several files look like skill files. Choose one; the others
                    stay as supporting files.
                  </div>
                )}
            </dd>
            <dt>
              <label htmlFor="import-name">Name</label>
            </dt>
            <dd>
              <input
                id="import-name"
                value={name ?? preview.name}
                onChange={(e) => {
                  setName(e.target.value.trim());
                  setConfirmReplace(false);
                }}
              />
              {preview.rename && (
                <div className="muted">
                  name: {preview.rename.from} → {preview.rename.to} (changed in
                  the imported copy only)
                </div>
              )}
              {preview.builtin_name && (
                <div className="muted">
                  Also a built-in skill; that one is separate and unchanged.
                </div>
              )}
            </dd>
            <dt>Destination</dt>
            <dd>
              {context.scope === "personal" ? "My skills" : "Project"}:{" "}
              <code>{preview.folder || "…"}/SKILL.md</code>
            </dd>
            <dt>Description</dt>
            <dd>{preview.description || "—"}</dd>
            <dt>Licence</dt>
            <dd>{preview.licence ?? "Not specified"}</dd>
            <dt>Files</dt>
            <dd>
              <ul className="import-files">
                {preview.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>{" "}
                    <span className="muted">{size(file.size)}</span>
                  </li>
                ))}
              </ul>
              {preview.excluded.length > 0 && (
                <div className="muted">
                  Not imported: {preview.excluded.join(", ")}
                </div>
              )}
              {upload.single_file && (
                <div className="muted">
                  Only this file is imported, as SKILL.md; other files next to
                  it are not included.
                </div>
              )}
            </dd>
          </dl>
          <details>
            <summary>SKILL.md as it will be saved</summary>
            <pre className="import-manifest">{preview.manifest_text}</pre>
          </details>
          {preview.missing_references.length > 0 && (
            <p className="import-box warn">
              This file links to files that aren't included:{" "}
              {preview.missing_references.join(", ")}. Import the folder to
              bring them along.
            </p>
          )}
          {preview.broken_links.length > 0 && (
            <p className="import-box warn">
              These files mention {preview.skill_file}, which becomes SKILL.md;
              their links aren't rewritten: {preview.broken_links.join(", ")}.
            </p>
          )}
          {preview.destination_clash && (
            <div className="import-box error">
              <p>
                {preview.destination_clash} would also become SKILL.md (the Mac
                ignores letter case).
              </p>
              <div className="actions">
                <button
                  onClick={() =>
                    setLeaveOut([...leaveOut, preview.destination_clash ?? ""])
                  }
                >
                  Leave {preview.destination_clash} out
                </button>
                <button
                  onClick={() =>
                    setSkillFile(preview.destination_clash ?? undefined)
                  }
                >
                  Use {preview.destination_clash} as the skill file
                </button>
              </div>
            </div>
          )}
          {preview.errors
            .filter(
              (message) =>
                !preview.destination_clash ||
                !message.startsWith(preview.destination_clash),
            )
            .map((message) => (
              <p key={message} className="import-box error">
                {message}
              </p>
            ))}
          {collision?.kind === "tracked" && (
            <div className="import-box warn">
              <p>
                <strong>{preview.name}</strong> already exists (rev{" "}
                {collision.number}
                {collision.used_by.length
                  ? `, used by ${collision.used_by.join(", ")}`
                  : ", not used by any agent"}
                ).{" "}
                {collision.pending
                  ? `Its folder from an earlier change isn't written yet (${collision.pending.detail}) Resolve that in Manage library first, or use another name.`
                  : collision.draft
                    ? "It has unsaved edits. Save or discard them first, or use another name."
                    : `Replace saves this import as rev ${collision.number + 1}. Rev ${collision.number} stays in History, and agents stay on it until you update them.`}
              </p>
              <div className="actions">
                <button onClick={() => setName(`${preview.name}-2`)}>
                  Use another name
                </button>
                {!collision.draft &&
                  !collision.pending &&
                  (confirmReplace ? (
                    <button
                      className="danger"
                      disabled={busy || !ready}
                      onClick={() => void confirm("replace")}
                    >
                      Replace {preview.name}
                    </button>
                  ) : (
                    <button onClick={() => setConfirmReplace(true)}>
                      Replace…
                    </button>
                  ))}
              </div>
            </div>
          )}
          {collision?.kind === "trashed" && (
            <p className="import-box error">
              <strong>{preview.name}</strong> is in Trash. Restore it first to
              replace it, or use another name.{" "}
              <button onClick={() => setName(`${preview.name}-2`)}>
                Use another name
              </button>
            </p>
          )}
          {collision?.kind === "untracked" && (
            <p className="import-box error">
              A folder <code>{preview.name}</code> already exists but isn't a
              saved skill. Adopt or move it first, or use another name.{" "}
              <button onClick={() => setName(`${preview.name}-2`)}>
                Use another name
              </button>
            </p>
          )}
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !ready || collision?.kind === "tracked"}
              onClick={() => void confirm("create")}
            >
              Import
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
