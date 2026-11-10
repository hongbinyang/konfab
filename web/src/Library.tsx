import { useCallback, useEffect, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import { request } from "./api";

type Skill = {
  id: string;
  name: string;
  description: string;
  reviewed_at: number | null;
  licence: string | null;
  provenance_json: string;
  usage_count: number;
};
type Detail = Skill & {
  current_revision_id: string;
  root_path: string;
  folder_name: string;
  draft_hash: string | null;
  draft_error: string | null;
  is_draft: boolean | null;
  files: { path: string; size: number }[];
};
type Revision = {
  id: string;
  number: number;
  name: string;
  reviewed_at: number | null;
};

export function Library({
  roomId,
  onDirtyChange,
}: {
  roomId: number | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [scope, setScope] = useState<"personal" | "project">("personal");
  const [trash, setTrash] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [historyText, setHistoryText] = useState("");
  const [copyName, setCopyName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [filePath, setFilePath] = useState("");
  const [upload, setUpload] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [loadedBody, setLoadedBody] = useState("");
  const [error, setError] = useState("");
  const context = {
    scope,
    ...(scope === "project" && roomId ? { room_id: roomId } : {}),
  };
  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams({ scope, trash: String(trash) });
      if (scope === "project" && roomId) params.set("room_id", String(roomId));
      const result = await request<{
        skills: Skill[];
        untracked: string[];
        unavailable?: boolean;
      }>(`/api/library?${params}`);
      setSkills(result.skills);
      setUntracked(result.untracked);
      setError(
        result.unavailable
          ? "Project folder unavailable; saved history is still readable."
          : "",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Library unavailable");
    }
  }, [scope, trash, roomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const dirty = !!selected && body !== loadedBody;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const canLeave = () =>
    !dirty || window.confirm("Discard unsaved editor changes?");
  async function open(id: string) {
    const detail = await request<Detail>(`/api/library/skills/${id}`);
    const history = await request<Revision[]>(
      `/api/library/skills/${id}/revisions`,
    );
    let text = "";
    if (!detail.draft_error) {
      const data = await request<{ content_base64: string }>(
        `/api/library/skills/${id}/files?path=SKILL.md`,
      );
      const bytes = Uint8Array.from(atob(data.content_base64), (c) =>
        c.charCodeAt(0),
      );
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    setBody(text);
    setLoadedBody(text);
    setSelected(detail);
    setRevisions(history);
    setHistoryText("");
  }
  async function run(action: () => Promise<void>) {
    try {
      await action();
      setError("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (!canLeave()) return;
    void run(async () => {
      const result = await request<{ id: string }>("/api/library/skills", {
        method: "POST",
        body: { ...context, name, description },
      });
      setName("");
      setDescription("");
      await open(result.id);
    });
  }
  function save() {
    if (!selected?.draft_hash) return;
    void run(async () => {
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const written = await request<{ draft_hash: string }>(
        `/api/library/skills/${selected.id}/files`,
        {
          method: "PUT",
          body: {
            path: "SKILL.md",
            content_base64: btoa(binary),
            base_revision_id: selected.current_revision_id,
            base_draft_hash: selected.draft_hash,
          },
        },
      );
      setSelected({ ...selected, draft_hash: written.draft_hash });
      setLoadedBody(body);
      await request(`/api/library/skills/${selected.id}/save`, {
        method: "POST",
        body: {
          base_revision_id: selected.current_revision_id,
          base_draft_hash: written.draft_hash,
        },
      });
      await open(selected.id);
    });
  }
  return (
    <div className="library">
      <h1>Skill Library</h1>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          onClick={() => {
            if (!canLeave()) return;
            setScope("personal");
            setSelected(null);
          }}
        >
          Mine
        </button>
        <button
          onClick={() => {
            if (!canLeave()) return;
            setScope("project");
            setSelected(null);
          }}
        >
          Project
        </button>
        <button
          onClick={() => {
            if (!canLeave()) return;
            setTrash(!trash);
            setSelected(null);
          }}
        >
          {trash ? "Active" : "Trash"}
        </button>
      </div>
      <p>
        {scope === "personal"
          ? "Personal library"
          : "Project library for the selected room"}
      </p>
      <input
        aria-label="Search skills"
        placeholder="Search skills"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul>
        {skills
          .filter((s) =>
            `${s.name} ${s.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((s) => (
            <li key={s.id}>
              <button
                onClick={() => {
                  if (canLeave()) void run(() => open(s.id));
                }}
              >
                {s.name}
              </button>{" "}
              {s.description} · {s.reviewed_at ? "Reviewed" : "Not reviewed"} ·{" "}
              {s.licence ?? "Licence not specified"} · used by {s.usage_count}
            </li>
          ))}
      </ul>
      {!trash &&
        untracked.map((folder) => (
          <p key={folder}>
            {folder} · Untracked{" "}
            <button
              onClick={() => {
                if (!canLeave()) return;
                void run(async () => {
                  const result = await request<{ id: string }>(
                    "/api/library/adopt",
                    { method: "POST", body: { ...context, folder } },
                  );
                  await open(result.id);
                });
              }}
            >
              Adopt
            </button>
          </p>
        ))}
      {!trash && (
        <form onSubmit={create} className="stack">
          <h2>New skill</h2>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </label>
          <button>Create</button>
        </form>
      )}
      {selected && (
        <section>
          <h2>{selected.name}</h2>
          <p>
            Licence: {selected.licence ?? "Not specified"} · Provenance:{" "}
            {selected.provenance_json === "{}"
              ? "Created or adopted locally"
              : "Derived from another saved skill revision"}
          </p>
          <p>
            Working folder:{" "}
            <code>
              {selected.root_path}/{selected.folder_name}
            </code>{" "}
            <button
              onClick={() =>
                void run(async () =>
                  navigator.clipboard.writeText(
                    `${selected.root_path}/${selected.folder_name}`,
                  ),
                )
              }
            >
              Copy path
            </button>
          </p>
          {selected.draft_error ? (
            <p>{selected.draft_error}</p>
          ) : (
            <>
              <p>
                {selected.is_draft
                  ? "Draft has unsaved changes"
                  : "Saved revision"}
              </p>
              <label>
                SKILL.md
                <textarea
                  rows={16}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <h3>Preview</h3>
              <Markdown>
                {body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
              </Markdown>
              <h3>Files</h3>
              <ul>
                {selected.files.map((file) => (
                  <li key={file.path}>
                    {file.path} ({file.size} bytes){" "}
                    <button
                      onClick={() =>
                        void run(async () => {
                          const data = await request<{
                            content_base64: string;
                          }>(
                            `/api/library/skills/${selected.id}/files?path=${encodeURIComponent(file.path)}`,
                          );
                          const bytes = Uint8Array.from(
                            atob(data.content_base64),
                            (c) => c.charCodeAt(0),
                          );
                          const url = URL.createObjectURL(new Blob([bytes]));
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = file.path.split("/").at(-1) ?? "file";
                          link.click();
                          URL.revokeObjectURL(url);
                        })
                      }
                    >
                      Download
                    </button>
                    {!trash && file.path !== "SKILL.md" && (
                      <button
                        disabled={dirty}
                        onClick={() =>
                          void run(async () => {
                            await request(
                              `/api/library/skills/${selected.id}/files/delete`,
                              {
                                method: "POST",
                                body: {
                                  path: file.path,
                                  base_revision_id:
                                    selected.current_revision_id,
                                  base_draft_hash: selected.draft_hash,
                                },
                              },
                            );
                            await open(selected.id);
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {!trash && (
                <div>
                  <label>
                    File path
                    <input
                      value={filePath}
                      onChange={(e) => setFilePath(e.target.value)}
                    />
                  </label>
                  <label>
                    Choose file
                    <input
                      type="file"
                      onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button
                    disabled={dirty || !upload || !filePath}
                    onClick={() =>
                      void run(async () => {
                        if (!upload || !selected.draft_hash)
                          throw new Error("Choose a file");
                        if (upload.size > 512 * 1024)
                          throw new Error("File exceeds 512 KiB");
                        const bytes = new Uint8Array(
                          await upload.arrayBuffer(),
                        );
                        let binary = "";
                        for (const byte of bytes)
                          binary += String.fromCharCode(byte);
                        await request(
                          `/api/library/skills/${selected.id}/files`,
                          {
                            method: "PUT",
                            body: {
                              path: filePath,
                              content_base64: btoa(binary),
                              base_revision_id: selected.current_revision_id,
                              base_draft_hash: selected.draft_hash,
                            },
                          },
                        );
                        setFilePath("");
                        setUpload(null);
                        await open(selected.id);
                      })
                    }
                  >
                    Add file to draft
                  </button>
                </div>
              )}
              {!trash && <button onClick={save}>Save revision</button>}
            </>
          )}
          {!trash && (
            <>
              {body !== loadedBody && (
                <p>
                  Save the editor changes before changing or leaving this skill.
                </p>
              )}
              <label>
                New name
                <input
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                />
              </label>
              <button
                disabled={body !== loadedBody}
                onClick={() =>
                  void run(async () => {
                    if (!selected.draft_hash)
                      throw new Error("Draft unavailable");
                    await request(`/api/library/skills/${selected.id}/rename`, {
                      method: "POST",
                      body: {
                        name: renameTo,
                        base_revision_id: selected.current_revision_id,
                        base_draft_hash: selected.draft_hash,
                      },
                    });
                    setRenameTo("");
                    await open(selected.id);
                  })
                }
              >
                Rename
              </button>
              <label>
                Copy name
                <input
                  value={copyName}
                  onChange={(e) => setCopyName(e.target.value)}
                />
              </label>
              <button
                disabled={body !== loadedBody}
                onClick={() =>
                  void run(async () => {
                    const result = await request<{ id: string }>(
                      `/api/library/skills/${selected.id}/duplicate`,
                      {
                        method: "POST",
                        body: {
                          ...context,
                          revision_id: selected.current_revision_id,
                          name: copyName,
                        },
                      },
                    );
                    setCopyName("");
                    await open(result.id);
                  })
                }
              >
                Duplicate revision
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    await request(
                      `/api/library/skills/${selected.id}/reviews/${selected.current_revision_id}`,
                      { method: "PUT" },
                    );
                    await open(selected.id);
                  })
                }
              >
                Mark saved revision reviewed
              </button>
              <button
                disabled={body !== loadedBody}
                onClick={() =>
                  void run(async () => {
                    await request(`/api/library/skills/${selected.id}/trash`, {
                      method: "POST",
                      body: {
                        base_revision_id: selected.current_revision_id,
                        base_draft_hash: selected.draft_hash,
                      },
                    });
                    setSelected(null);
                  })
                }
              >
                Move to Trash
              </button>
            </>
          )}
          {trash && (
            <button
              onClick={() =>
                void run(async () => {
                  await request(`/api/library/skills/${selected.id}/restore`, {
                    method: "POST",
                    body: {
                      base_revision_id: selected.current_revision_id,
                      base_draft_hash: selected.draft_hash,
                    },
                  });
                  setSelected(null);
                })
              }
            >
              Restore
            </button>
          )}
          <h3>History</h3>
          <ul>
            {revisions.map((r) => (
              <li key={r.id}>
                Revision {r.number}: {r.name} ·{" "}
                {r.reviewed_at ? "Reviewed" : "Not reviewed"}{" "}
                <button
                  onClick={() =>
                    void run(async () => {
                      const data = await request<{ content_base64: string }>(
                        `/api/library/skills/${selected.id}/revisions/${r.id}/files?path=SKILL.md`,
                      );
                      setHistoryText(
                        new TextDecoder().decode(
                          Uint8Array.from(atob(data.content_base64), (c) =>
                            c.charCodeAt(0),
                          ),
                        ),
                      );
                    })
                  }
                >
                  View
                </button>
                {!trash && (
                  <button
                    disabled={body !== loadedBody || !selected.draft_hash}
                    onClick={() =>
                      void run(async () => {
                        if (
                          selected.is_draft &&
                          !window.confirm(
                            "Replace the saved draft with this revision?",
                          )
                        )
                          return;
                        await request(
                          `/api/library/skills/${selected.id}/revisions/${r.id}/restore`,
                          {
                            method: "POST",
                            body: {
                              base_revision_id: selected.current_revision_id,
                              base_draft_hash: selected.draft_hash,
                            },
                          },
                        );
                        await open(selected.id);
                        setHistoryText("");
                      })
                    }
                  >
                    Restore as new revision
                  </button>
                )}
              </li>
            ))}
          </ul>
          {historyText && (
            <section>
              <h4>Historical revision</h4>
              <Markdown>
                {historyText.replace(
                  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                  "",
                )}
              </Markdown>
              <button onClick={() => setHistoryText("")}>Close</button>
            </section>
          )}
        </section>
      )}
    </div>
  );
}
