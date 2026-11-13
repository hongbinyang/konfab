import { useCallback, useEffect, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import { request } from "./api";
import { NameField } from "./NameField";
import { validName } from "./name-validation";

type Skill = {
  id: string;
  name: string;
  description: string;
  reviewed_at: number | null;
  licence: string | null;
  provenance_json: string;
  usage_count: number;
  workspace_state?: "pending" | "complete" | null;
  is_draft?: boolean | null;
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
  const [scope, setScope] = useState<"personal" | "project" | "builtin">(
    "personal",
  );
  const [publicTab, setPublicTab] = useState(false);
  const builtin = scope === "builtin";
  const [trash, setTrash] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [untrackedDetails, setUntrackedDetails] = useState<
    { folder: string; diagnostic: string | null }[]
  >([]);
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
  // Built-in skills are read-only; copies of them go to the personal library.
  const context = {
    scope: scope === "builtin" ? ("personal" as const) : scope,
    ...(scope === "project" && roomId ? { room_id: roomId } : {}),
  };
  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams({ scope, trash: String(trash) });
      if (scope === "project" && roomId) params.set("room_id", String(roomId));
      const result = await request<{
        skills: Skill[];
        untracked: string[];
        untracked_details?: { folder: string; diagnostic: string | null }[];
        unavailable?: boolean;
      }>(builtin ? "/api/library/builtin" : `/api/library?${params}`);
      setSkills(result.skills);
      setUntracked(result.untracked);
      setUntrackedDetails(result.untracked_details ?? []);
      setError(
        result.unavailable
          ? "Project folder unavailable; saved history is still readable."
          : "",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Library unavailable");
    }
  }, [scope, trash, roomId, builtin]);
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
      <p className="muted">
        Skills are what you assign to agents: each one can describe
        responsibilities, a procedure, or both. Assign them from an agent&apos;s
        card with Assign skills.
      </p>
      <div>
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <div className="library-navigation" aria-label="Skill collections">
          <button
            aria-pressed={!publicTab && scope === "personal" && !trash}
            onClick={() => {
              if (!canLeave()) return;
              setPublicTab(false);
              setTrash(false);
              setScope("personal");
              setSelected(null);
            }}
          >
            Mine
          </button>
          <button
            aria-pressed={!publicTab && scope === "project" && !trash}
            onClick={() => {
              if (!canLeave()) return;
              setPublicTab(false);
              setTrash(false);
              setScope("project");
              setSelected(null);
            }}
          >
            Project
          </button>
          <button
            aria-pressed={!publicTab && builtin}
            onClick={() => {
              if (!canLeave()) return;
              setPublicTab(false);
              setTrash(false);
              setScope("builtin");
              setSelected(null);
            }}
          >
            Built-in
          </button>
          <button
            aria-pressed={!publicTab && trash}
            onClick={() => {
              if (!canLeave()) return;
              setPublicTab(false);
              setTrash(!trash);
              setSelected(null);
            }}
          >
            {trash ? "Active" : "Trash"}
          </button>
          <button
            aria-pressed={publicTab}
            onClick={() => {
              if (!canLeave()) return;
              setPublicTab(true);
              setSelected(null);
            }}
          >
            Public
          </button>
        </div>
        {publicTab && <PublicSources />}
        <div hidden={publicTab}>
          <p>
            {scope === "personal"
              ? "Personal library"
              : builtin
                ? "Built-in skills ship with Konfab and are read-only. Duplicate one to make an editable copy in your library."
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
                    {s.is_draft ? " · Draft" : ""}
                  </button>{" "}
                  {s.description} ·{" "}
                  {s.reviewed_at ? "Reviewed" : "Not reviewed"} ·{" "}
                  {s.licence ?? "Licence not specified"} · used by{" "}
                  {s.usage_count}
                  {s.workspace_state === "pending" && (
                    <p role="alert">
                      {s.name}: the working folder could not be created. Check
                      for a conflicting folder or access problem, then restart
                      to retry. The assigned revision remains available.
                    </p>
                  )}
                </li>
              ))}
          </ul>
          {!trash &&
            untracked.map((folder) => (
              <p key={folder}>
                {folder} · Untracked{" "}
                {untrackedDetails.find((item) => item.folder === folder)
                  ?.diagnostic ? (
                  <span>
                    {
                      untrackedDetails.find((item) => item.folder === folder)
                        ?.diagnostic
                    }{" "}
                    · Fix the folder before adopting
                  </span>
                ) : (
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
                )}
              </p>
            ))}
          {!trash && !builtin && (
            <form onSubmit={create} className="stack">
              <h2>New skill</h2>
              <NameField
                label="Name"
                value={name}
                onChange={setName}
                required
              />
              <label>
                Description
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                />
              </label>
              <button disabled={!validName(name)}>Create</button>
            </form>
          )}
          {selected && (
            <section>
              <h2>{selected.name}</h2>
              <p>
                Licence: {selected.licence ?? "Not specified"} · Provenance:{" "}
                {selected.provenance_json === "{}"
                  ? "Created or adopted locally"
                  : selected.provenance_json.includes('"builtin":true')
                    ? "Ships with Konfab"
                    : selected.provenance_json.includes("converted_from_role")
                      ? "Converted from a role when roles became skills"
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
                      readOnly={builtin}
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
                              const url = URL.createObjectURL(
                                new Blob([bytes]),
                              );
                              const link = document.createElement("a");
                              link.href = url;
                              link.download =
                                file.path.split("/").at(-1) ?? "file";
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
                  {!trash && !builtin && (
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
                          onChange={(e) =>
                            setUpload(e.target.files?.[0] ?? null)
                          }
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
                                  base_revision_id:
                                    selected.current_revision_id,
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
                  {!trash && !builtin && (
                    <button onClick={save}>Save revision</button>
                  )}
                </>
              )}
              {!trash && (
                <>
                  {body !== loadedBody && (
                    <p>
                      Save the editor changes before changing or leaving this
                      skill.
                    </p>
                  )}
                  {!builtin && (
                    <NameField
                      label="New name"
                      value={renameTo}
                      onChange={setRenameTo}
                    />
                  )}
                  <button
                    hidden={builtin}
                    disabled={body !== loadedBody || !validName(renameTo)}
                    onClick={() =>
                      void run(async () => {
                        if (!selected.draft_hash)
                          throw new Error("Draft unavailable");
                        await request(
                          `/api/library/skills/${selected.id}/rename`,
                          {
                            method: "POST",
                            body: {
                              name: renameTo,
                              base_revision_id: selected.current_revision_id,
                              base_draft_hash: selected.draft_hash,
                            },
                          },
                        );
                        setRenameTo("");
                        await open(selected.id);
                      })
                    }
                  >
                    Rename
                  </button>
                  <NameField
                    label="Copy name"
                    value={copyName}
                    onChange={setCopyName}
                  />
                  <button
                    disabled={body !== loadedBody || !validName(copyName)}
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
                    hidden={builtin}
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
                    hidden={builtin}
                    disabled={body !== loadedBody}
                    onClick={() =>
                      void run(async () => {
                        await request(
                          `/api/library/skills/${selected.id}/trash`,
                          {
                            method: "POST",
                            body: {
                              base_revision_id: selected.current_revision_id,
                              base_draft_hash: selected.draft_hash,
                            },
                          },
                        );
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
                      await request(
                        `/api/library/skills/${selected.id}/restore`,
                        {
                          method: "POST",
                          body: {
                            base_revision_id: selected.current_revision_id,
                            base_draft_hash: selected.draft_hash,
                          },
                        },
                      );
                      setSelected(null);
                    })
                  }
                >
                  Restore
                </button>
              )}
              {!trash && (
                <UsedBy
                  skillId={selected.id}
                  currentRevision={selected.current_revision_id}
                />
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
                          const data = await request<{
                            content_base64: string;
                          }>(
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
                                  base_revision_id:
                                    selected.current_revision_id,
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
      </div>
    </div>
  );
}

type PublicSource = {
  id: string;
  owner: string;
  repository: string;
  badge: "vendor" | "community";
  enabled: number;
  rate_limit_reset: number | null;
};
type GitHubStatus = {
  mode: "token" | "public";
  state: "not_checked" | "accepted" | "rejected" | "unavailable";
  limit: number | null;
  remaining: number | null;
  reset_at: number | null;
  checked_at: number | null;
};

function PublicSources() {
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [owner, setOwner] = useState("");
  const [repository, setRepository] = useState("");
  const [error, setError] = useState("");
  const [token, setToken] = useState<{
    available: boolean;
    enabled: boolean;
    source?: string;
  }>({ available: false, enabled: false });
  const [github, setGithub] = useState<GitHubStatus | null>(null);
  const [checkingGithub, setCheckingGithub] = useState(false);
  const load = useCallback(async () => {
    const data = await request<{
      sources: PublicSource[];
      token: { available: boolean; enabled: boolean; source?: string };
      github: GitHubStatus;
    }>("/api/library/sources");
    setSources(data.sources);
    setToken(data.token);
    setGithub(data.github);
  }, []);
  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : "Sources unavailable"),
    );
  }, [load]);
  async function act(action: () => Promise<void>) {
    try {
      await action();
      setError("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    }
  }
  return (
    <section className="stack">
      <p>
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              const { bytes } = await request<{ bytes: number }>(
                "/api/library/legacy-indexes",
              );
              if (
                !window.confirm(
                  `Remove approximately ${(bytes / 1024 / 1024).toFixed(1)} MB of old fetched indexes? Your saved skills are not affected.`,
                )
              )
                return;
              await request("/api/library/legacy-indexes", {
                method: "DELETE",
              });
              await load();
            })
          }
        >
          Remove old fetched indexes
        </button>
      </p>
      <h2>Public sources</h2>
      <p>
        Enable sources here, then browse public skills from the role picker.
      </p>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {token.available && (
        <label>
          <input
            type="checkbox"
            checked={token.enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              if (
                enabled &&
                !window.confirm(
                  "Send your GitHub token only to api.github.com for future requests? It will not be stored or logged by Konfab.",
                )
              )
                return;
              void act(async () => {
                setToken(
                  await request("/api/library/source-token", {
                    method: "PUT",
                    body: { enabled, acknowledged: enabled },
                  }),
                );
              });
            }}
          />
          Use the GitHub token for API requests (
          {token.source === "keychain" ? "macOS Keychain" : "environment"})
        </label>
      )}
      <section aria-label="GitHub status">
        <p role="status">
          GitHub:{" "}
          {token.enabled && !token.available
            ? "token enabled but unavailable in this server; restart with a token"
            : github?.state === "rejected"
              ? "Token rejected by GitHub. Check that it hasn't expired."
              : github?.state === "not_checked" || !github
                ? `${github?.mode === "token" ? "token enabled" : "no token"} · not checked yet`
                : github.state === "unavailable"
                  ? `${github.mode === "token" ? "token enabled" : "no token"} · GitHub response unavailable`
                  : `${github.mode === "token" ? "using your token" : "no token"}${github.remaining !== null && github.limit !== null ? ` · ${github.remaining.toLocaleString()} of ${github.limit.toLocaleString()} left` : ""}${github.reset_at !== null ? ` · resets ${new Date(github.reset_at).toLocaleTimeString()}` : ""}`}
        </p>
        {github?.checked_at && (
          <p className="muted">
            Last response: {new Date(github.checked_at).toLocaleString()}
          </p>
        )}
        <button
          type="button"
          disabled={checkingGithub}
          onClick={() => {
            setCheckingGithub(true);
            void act(async () => {
              await request("/api/library/github-status/check", {
                method: "POST",
              });
            }).finally(() => setCheckingGithub(false));
          }}
        >
          {checkingGithub ? "Checking…" : "Check GitHub status"}
        </button>
      </section>
      <details>
        <summary>
          Sources ({sources.filter((source) => source.enabled === 1).length}{" "}
          enabled)
        </summary>
        {sources.map((source) => (
          <article key={source.id}>
            <label>
              <input
                type="checkbox"
                checked={!!source.enabled}
                onChange={(e) =>
                  void act(async () => {
                    await request(`/api/library/sources/${source.id}`, {
                      method: "PUT",
                      body: { enabled: e.target.checked },
                    });
                  })
                }
              />
              {source.owner}/{source.repository} ·{" "}
              {source.badge === "vendor" ? "Vendor-maintained" : "Community"}
            </label>{" "}
          </article>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await request("/api/library/sources", {
                method: "POST",
                body: { owner, repository, ref: "HEAD" },
              });
              setOwner("");
              setRepository("");
            });
          }}
        >
          <h3>Add a GitHub source</h3>
          <input
            aria-label="GitHub owner"
            placeholder="Owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            required
          />
          <input
            aria-label="GitHub repository"
            placeholder="Repository"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            required
          />
          <button>Add source</button>
        </form>
      </details>
    </section>
  );
}

type Usage = {
  room_id: number;
  room_name: string;
  agent_id: string;
  member_name: string;
  revision_id: string;
  number: number;
  base_revision: number;
  archived: number;
};

/**
 * Who uses a skill, across rooms, and the update to its current revision for
 * the members the lead selects. Everyone else stays pinned.
 */
function UsedBy({
  skillId,
  currentRevision,
}: {
  skillId: string;
  currentRevision: string;
}) {
  const [usages, setUsages] = useState<Usage[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = (usage: Usage) => `${usage.room_id}:${usage.agent_id}`;
  const load = useCallback(async () => {
    try {
      const result = await request<{ usages: Usage[] }>(
        `/api/library/skills/${encodeURIComponent(skillId)}/usages`,
      );
      setUsages(result.usages);
      setPicked([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Usage unavailable");
    }
  }, [skillId]);
  useEffect(() => {
    void load();
  }, [load, currentRevision]);
  const outdated = usages.filter(
    (usage) => usage.revision_id !== currentRevision && !usage.archived,
  );
  return (
    <section aria-label="Used by">
      <h3>Used by</h3>
      {error && <p role="alert">{error}</p>}
      {usages.length === 0 ? (
        <p className="muted">Not assigned to anyone.</p>
      ) : (
        <ul>
          {usages.map((usage) => {
            const current = usage.revision_id === currentRevision;
            return (
              <li key={key(usage)}>
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={current || !!usage.archived || busy}
                    checked={picked.includes(key(usage))}
                    onChange={(event) =>
                      setPicked((list) =>
                        event.target.checked
                          ? [...list, key(usage)]
                          : list.filter((item) => item !== key(usage)),
                      )
                    }
                  />{" "}
                  {usage.room_name} · {usage.member_name} · rev {usage.number}
                  {current
                    ? " (current)"
                    : usage.archived
                      ? " · archived room, not updated"
                      : ""}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {outdated.length > 0 && (
        <button
          type="button"
          disabled={!picked.length || busy}
          onClick={() => {
            if (
              !window.confirm(
                `Review the current revision and update ${picked.length} member${picked.length === 1 ? "" : "s"} to it? Others stay pinned. The change applies from each agent's next turn.`,
              )
            )
              return;
            setBusy(true);
            setError("");
            void request(
              `/api/library/skills/${encodeURIComponent(skillId)}/update-assignments`,
              {
                method: "POST",
                body: {
                  revision_id: currentRevision,
                  targets: usages
                    .filter((usage) => picked.includes(key(usage)))
                    .map((usage) => ({
                      room_id: usage.room_id,
                      agent_id: usage.agent_id,
                      base_revision: usage.base_revision,
                    })),
                  review: true,
                },
              },
            )
              .then(load)
              .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Update failed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          Review and update {picked.length} member
          {picked.length === 1 ? "" : "s"}
        </button>
      )}
    </section>
  );
}
