import { useCallback, useEffect, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import { request } from "./api";
import { ConvertRoles } from "./ConvertRoles";
import { NameField } from "./NameField";
import { suggestName, validName } from "./name-validation";

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
  const [scope, setScope] = useState<"personal" | "project">("personal");
  const [publicTab, setPublicTab] = useState(false);
  const [rolesTab, setRolesTab] = useState(false);
  const [roleDirty, setRoleDirty] = useState(false);
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
        untracked_details?: { folder: string; diagnostic: string | null }[];
        unavailable?: boolean;
      }>(`/api/library?${params}`);
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
  }, [scope, trash, roomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const dirty = !!selected && body !== loadedBody;
  useEffect(() => {
    onDirtyChange(dirty || roleDirty);
  }, [dirty, roleDirty, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || roleDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, roleDirty]);
  const canLeave = () =>
    (!dirty && !roleDirty) || window.confirm("Discard unsaved editor changes?");
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
      <div className="row">
        <button
          aria-pressed={!rolesTab}
          onClick={() => {
            if (canLeave()) setRolesTab(false);
          }}
        >
          Skills
        </button>
        <button
          aria-pressed={rolesTab}
          onClick={() => {
            if (canLeave()) setRolesTab(true);
          }}
        >
          Roles
        </button>
      </div>
      {rolesTab && <RolesView onDirtyChange={setRoleDirty} />}
      <div hidden={rolesTab}>
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
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
        {publicTab && <PublicSources roomId={roomId} />}
        <div hidden={publicTab}>
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
          {!trash && (
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
                  {!trash && <button onClick={save}>Save revision</button>}
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
                  <NameField
                    label="New name"
                    value={renameTo}
                    onChange={setRenameTo}
                  />
                  <button
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

function RolesView({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [roles, setRoles] = useState<
    Array<{
      id: string;
      title: string;
      description: string;
      library_id: string;
      revision_id: string;
      number: number;
    }>
  >([]);
  const [selected, setSelected] = useState<null | {
    id: string;
    title: string;
    library_id: string;
    revision_id: string;
    role_md: string;
    workspace_state: string | null;
    is_draft: boolean | null;
    root_path: string;
    folder_name: string;
    skills: Array<{
      skill_id: string;
      skill_revision_id: string;
      name: string;
      reviewed: number;
    }>;
  }>(null);
  const [name, setName] = useState("");
  const [availableSkills, setAvailableSkills] = useState<
    Array<{
      id: string;
      name: string;
      current_revision_id: string;
      reviewed_at: number | null;
    }>
  >([]);
  const [skillChoice, setSkillChoice] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [converting, setConverting] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [roleCopyName, setRoleCopyName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [history, setHistory] = useState<
    Array<{ id: string; number: number; title: string }>
  >([]);
  const [externalDraft, setExternalDraft] = useState<null | {
    revision_id: string;
    draft_hash: string;
    manifest: string;
  }>(null);
  const [loadedRole, setLoadedRole] = useState("");
  const roleValue = (item: NonNullable<typeof selected>) =>
    JSON.stringify([
      item.role_md,
      item.skills.map((skill) => [skill.skill_id, skill.skill_revision_id]),
    ]);
  const [error, setError] = useState("");
  const load = useCallback(
    async () =>
      setRoles(
        (
          await request<{ roles: typeof roles }>(
            `/api/roles?trash=${showTrash}`,
          )
        ).roles,
      ),
    [showTrash],
  );
  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : "Roles unavailable"),
    );
    void request<{ skills: typeof availableSkills }>(
      "/api/library?scope=personal",
    ).then((result) => setAvailableSkills(result.skills));
  }, [load]);
  async function open(id: string, force = false) {
    if (
      !force &&
      selected &&
      roleValue(selected) !== loadedRole &&
      !window.confirm("Discard unsaved role edits?")
    )
      return;
    const detail = await request<NonNullable<typeof selected>>(
      `/api/roles/${encodeURIComponent(id)}`,
    );
    setSelected(detail);
    setLoadedRole(roleValue(detail));
    setHistory(await request(`/api/roles/${encodeURIComponent(id)}/revisions`));
    setExternalDraft(null);
  }
  useEffect(() => {
    onDirtyChange(!!selected && roleValue(selected) !== loadedRole);
    return () => onDirtyChange(false);
  }, [selected, loadedRole, onDirtyChange]);
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
    <section>
      <h2>Roles</h2>
      <button onClick={() => setConverting(true)}>
        Convert all custom roles
      </button>
      {converting && (
        <ConvertRoles
          onClose={() => {
            setConverting(false);
            void load();
          }}
        />
      )}
      <button
        onClick={() => {
          setShowTrash(!showTrash);
          setSelected(null);
        }}
      >
        {showTrash ? "Active roles" : "Role Trash"}
      </button>
      {error && <p className="banner error">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            const result = await request<{ id: string }>("/api/roles", {
              method: "POST",
              body: { name, title: newTitle, description: newDescription },
            });
            setName("");
            setNewTitle("");
            setNameEdited(false);
            setNewDescription("");
            await open(result.id);
          });
        }}
      >
        <h3>New role</h3>
        <NameField
          label="Name"
          value={name}
          onChange={(value) => {
            setName(value);
            setNameEdited(true);
          }}
          required
        />
        <label>
          Title
          <input
            value={newTitle}
            onChange={(event) => {
              setNewTitle(event.target.value);
              if (!nameEdited) setName(suggestName(event.target.value));
            }}
            required
          />
        </label>
        <label>
          Description
          <input
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            required
          />
        </label>
        <button disabled={!validName(name)}>Create role</button>
      </form>
      {roles.map((role) => (
        <article key={role.id}>
          <button
            disabled={showTrash}
            onClick={() => void act(() => open(role.id))}
          >
            {role.title}
          </button>{" "}
          · {role.library_id === "builtin" ? "Built-in · read-only" : "Mine"} ·
          revision {role.number}
          <p>{role.description}</p>
          {showTrash && (
            <button
              onClick={() =>
                void act(async () => {
                  await request(
                    `/api/roles/${encodeURIComponent(role.id)}/restore`,
                    {
                      method: "POST",
                      body: { base_revision: role.revision_id },
                    },
                  );
                })
              }
            >
              Restore
            </button>
          )}
        </article>
      ))}
      {selected && (
        <section>
          <h3>{selected.title}</h3>
          {selected.library_id === "personal" && (
            <p>
              Working folder:{" "}
              <code>
                {selected.root_path}/{selected.folder_name}
              </code>{" "}
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${selected.root_path}/${selected.folder_name}`,
                  )
                }
              >
                Copy path
              </button>
            </p>
          )}
          {selected.workspace_state === "pending" && (
            <p className="banner error">
              The role folder needs recovery. Your files have been preserved.
            </p>
          )}
          {selected.is_draft && (
            <p className="banner error">
              The working folder has changes. Review them before saving.
            </p>
          )}
          {selected.is_draft && (
            <button
              onClick={() =>
                void act(async () => {
                  setExternalDraft(
                    await request(
                      `/api/roles/${encodeURIComponent(selected.id)}/draft`,
                    ),
                  );
                })
              }
            >
              Review working draft
            </button>
          )}
          {externalDraft && (
            <section>
              <h4>Working draft</h4>
              <pre>{externalDraft.manifest}</pre>
              <button
                onClick={() =>
                  void act(async () => {
                    await request(
                      `/api/roles/${encodeURIComponent(selected.id)}/draft/save`,
                      {
                        method: "POST",
                        body: {
                          base_revision: externalDraft.revision_id,
                          draft_hash: externalDraft.draft_hash,
                          pins: selected.skills.map((skill) => ({
                            skill_id: skill.skill_id,
                            revision_id: skill.skill_revision_id,
                          })),
                        },
                      },
                    );
                    await open(selected.id, true);
                  })
                }
              >
                Save working draft
              </button>
            </section>
          )}
          {selected.library_id === "personal" ? (
            <textarea
              rows={15}
              value={selected.role_md}
              onChange={(e) =>
                setSelected({ ...selected, role_md: e.target.value })
              }
            />
          ) : (
            <pre>{selected.role_md}</pre>
          )}
          <p>
            Skills:{" "}
            {selected.skills.length
              ? selected.skills.map((s) => s.name).join(", ")
              : "None"}
          </p>
          {selected.library_id === "personal" && (
            <div>
              <select
                value={skillChoice}
                onChange={(event) => setSkillChoice(event.target.value)}
                aria-label="Add a skill revision"
              >
                <option value="">Choose a skill revision</option>
                {availableSkills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name} ·{" "}
                    {skill.reviewed_at ? "Reviewed" : "Not reviewed"}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const skill = availableSkills.find(
                    (item) => item.id === skillChoice,
                  );
                  if (
                    skill &&
                    !selected.skills.some((item) => item.skill_id === skill.id)
                  )
                    setSelected({
                      ...selected,
                      skills: [
                        ...selected.skills,
                        {
                          skill_id: skill.id,
                          skill_revision_id: skill.current_revision_id,
                          name: skill.name,
                          reviewed: skill.reviewed_at ? 1 : 0,
                        },
                      ],
                    });
                }}
              >
                Add skill
              </button>
              {selected.skills.map((skill, index) => (
                <p key={skill.skill_id}>
                  {skill.name} ·{" "}
                  {skill.reviewed ? "Reviewed" : "Review before assignment"}{" "}
                  <button
                    disabled={index === 0}
                    onClick={() => {
                      const pins = [...selected.skills];
                      [pins[index - 1], pins[index]] = [
                        pins[index]!,
                        pins[index - 1]!,
                      ];
                      setSelected({ ...selected, skills: pins });
                    }}
                  >
                    Move up
                  </button>{" "}
                  <button
                    disabled={index === selected.skills.length - 1}
                    onClick={() => {
                      const pins = [...selected.skills];
                      [pins[index], pins[index + 1]] = [
                        pins[index + 1]!,
                        pins[index]!,
                      ];
                      setSelected({ ...selected, skills: pins });
                    }}
                  >
                    Move down
                  </button>{" "}
                  {availableSkills.some(
                    (item) =>
                      item.id === skill.skill_id &&
                      item.current_revision_id !== skill.skill_revision_id,
                  ) && (
                    <button
                      onClick={() => {
                        const latest = availableSkills.find(
                          (item) => item.id === skill.skill_id,
                        )!;
                        setSelected({
                          ...selected,
                          skills: selected.skills.map((item) =>
                            item.skill_id === skill.skill_id
                              ? {
                                  ...item,
                                  skill_revision_id: latest.current_revision_id,
                                  reviewed: latest.reviewed_at ? 1 : 0,
                                }
                              : item,
                          ),
                        });
                      }}
                    >
                      Update skill revision
                    </button>
                  )}{" "}
                  <button
                    onClick={() =>
                      setSelected({
                        ...selected,
                        skills: selected.skills.filter(
                          (item) => item.skill_id !== skill.skill_id,
                        ),
                      })
                    }
                  >
                    Remove
                  </button>
                </p>
              ))}
            </div>
          )}
          {selected.library_id === "personal" && (
            <section>
              <h4>History</h4>
              {history.map((item) => (
                <p key={item.id}>
                  Revision {item.number}: {item.title}{" "}
                  <button
                    disabled={item.id === selected.revision_id}
                    onClick={() =>
                      void act(async () => {
                        if (
                          roleValue(selected) !== loadedRole &&
                          !window.confirm("Discard unsaved role edits?")
                        )
                          return;
                        await request(
                          `/api/roles/${encodeURIComponent(selected.id)}/revisions/${item.id}/restore`,
                          {
                            method: "POST",
                            body: { base_revision: selected.revision_id },
                          },
                        );
                        await open(selected.id, true);
                      })
                    }
                  >
                    Restore as new revision
                  </button>
                </p>
              ))}
            </section>
          )}
          {selected.library_id === "personal" && (
            <button
              onClick={() =>
                void act(async () => {
                  await request(
                    `/api/roles/${encodeURIComponent(selected.id)}/save`,
                    {
                      method: "POST",
                      body: {
                        base_revision: selected.revision_id,
                        manifest: selected.role_md,
                        pins: selected.skills.map((s) => ({
                          skill_id: s.skill_id,
                          revision_id: s.skill_revision_id,
                        })),
                      },
                    },
                  );
                  await open(selected.id, true);
                })
              }
            >
              Save revision
            </button>
          )}
          {selected.library_id === "personal" && (
            <button
              onClick={() =>
                void act(async () => {
                  if (
                    roleValue(selected) !== loadedRole &&
                    !window.confirm("Discard unsaved role edits?")
                  )
                    return;
                  await request(
                    `/api/roles/${encodeURIComponent(selected.id)}/trash`,
                    {
                      method: "POST",
                      body: { base_revision: selected.revision_id },
                    },
                  );
                  setSelected(null);
                })
              }
            >
              Move to Trash
            </button>
          )}
          <NameField
            label="Copy name"
            value={roleCopyName}
            onChange={setRoleCopyName}
          />
          <button
            disabled={!validName(roleCopyName)}
            onClick={() =>
              void act(async () => {
                if (
                  roleValue(selected) !== loadedRole &&
                  !window.confirm(
                    "Duplicate the saved revision and discard unsaved edits?",
                  )
                )
                  return;
                const result = await request<{ id: string }>(
                  `/api/roles/${encodeURIComponent(selected.id)}/duplicate`,
                  { method: "POST", body: { name: roleCopyName } },
                );
                setRoleCopyName("");
                await open(result.id, true);
              })
            }
          >
            Duplicate role
          </button>
        </section>
      )}
    </section>
  );
}

type PublicSource = {
  id: string;
  owner: string;
  repository: string;
  badge: "vendor" | "community";
  enabled: number;
  current_generation_id: string | null;
  current_commit: string | null;
  rate_limit_reset: number | null;
  latest: null | {
    state: "downloading" | "indexing" | "complete" | "failed";
    discovered: number;
    indexed: number;
    error: string | null;
  };
};
type PublicSkill = {
  path: string;
  name: string | null;
  description: string | null;
  licence: string | null;
  diagnostic: string | null;
  source_id: string;
  owner: string;
  repository: string;
  generation_id: string;
  commit_id: string;
};

type GitHubStatus = {
  mode: "token" | "public";
  state: "not_checked" | "accepted" | "rejected" | "unavailable";
  limit: number | null;
  remaining: number | null;
  reset_at: number | null;
  checked_at: number | null;
};

function PublicSources({ roomId }: { roomId: number | null }) {
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<null | {
    source: string;
    commit: string;
    name: string | null;
    description: string | null;
    licence: string | null;
    diagnostic: string | null;
    content: string | null;
    files: { path: string; size: number; kind: string }[];
    path: string;
    sourceId: string;
    generationId: string;
  }>(null);
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
  const [expanded, setExpanded] = useState<string[]>([]);
  const [importName, setImportName] = useState("");
  const [draft, setDraft] = useState<null | {
    id: string;
    name: string;
    manifest: string;
    diagnostic: string | null;
    revision: number;
  }>(null);
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
  const working = sources.some(
    (s) => s.latest && ["downloading", "indexing"].includes(s.latest.state),
  );
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void load(), 1200);
    return () => window.clearInterval(timer);
  }, [working, load]);
  async function browse(search = query) {
    const result = await request<{ skills: PublicSkill[] }>(
      `/api/library/public?q=${encodeURIComponent(search)}`,
    );
    setSkills(result.skills);
    setPreview(null);
  }
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
                  `Remove approximately ${(bytes / 1024 / 1024).toFixed(1)} MB of old fetched indexes? Your saved skills and roles are not affected.`,
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
        Nothing downloads automatically. The first index for anthropics/skills
        and openai/plugins is approximately 30 MB total.
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
                  "Send KONFAB_GITHUB_TOKEN only to api.github.com on future refreshes? It will not be stored or logged.",
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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => browse());
        }}
      >
        <input
          aria-label="Search public skills"
          placeholder="Search all enabled cached sources"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!sources.some((source) => source.current_generation_id)}
        />
        <button
          disabled={!sources.some((source) => source.current_generation_id)}
        >
          Search
        </button>
      </form>
      {skills.length > 0 && (
        <div className="public-results">
          {skills.map((skill) => (
            <article key={`${skill.source_id}:${skill.path}`}>
              <button
                onClick={() =>
                  void act(async () => {
                    const detail = await request<
                      Omit<
                        NonNullable<typeof preview>,
                        "sourceId" | "generationId"
                      >
                    >(
                      `/api/library/sources/${skill.source_id}/preview?generation=${skill.generation_id}&path=${encodeURIComponent(skill.path)}`,
                    );
                    setPreview({
                      ...detail,
                      sourceId: skill.source_id,
                      generationId: skill.generation_id,
                    });
                    setImportName(skill.name ?? "");
                    setDraft(null);
                  })
                }
              >
                {skill.name ?? skill.path}
              </button>
              {skill.diagnostic && (
                <span className="diagnostic-badge" title={skill.diagnostic}>
                  ⚠ {skill.diagnostic}
                </span>
              )}
              <p
                className={`public-description ${expanded.includes(skill.path) ? "expanded" : ""}`}
              >
                {skill.description ?? "No description"}
              </p>
              {skill.description && skill.description.length > 120 && (
                <button
                  className="link-button"
                  onClick={() =>
                    setExpanded((current) =>
                      current.includes(skill.path)
                        ? current.filter((path) => path !== skill.path)
                        : [...current, skill.path],
                    )
                  }
                >
                  {expanded.includes(skill.path) ? "Show less" : "Show more"}
                </button>
              )}
              <small>
                {skill.owner}/{skill.repository} at{" "}
                {skill.commit_id.slice(0, 8)} ·{" "}
                {skill.licence ?? "Licence not specified"}
              </small>
            </article>
          ))}
        </div>
      )}
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
            {source.enabled === 1 && (
              <button
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    await request(`/api/library/sources/${source.id}/refresh`, {
                      method: "POST",
                    });
                  })
                }
              >
                {source.current_generation_id ? "Refresh" : "Fetch"}
              </button>
            )}
            {source.latest?.state === "downloading" && (
              <span> Downloading…</span>
            )}
            {source.latest?.state === "indexing" && (
              <span>
                {" "}
                Indexing… {source.latest.indexed} of {source.latest.discovered}
              </span>
            )}
            {source.latest &&
              ["downloading", "indexing"].includes(source.latest.state) && (
                <button
                  onClick={() =>
                    void act(async () => {
                      await request(
                        `/api/library/sources/${source.id}/cancel`,
                        {
                          method: "POST",
                        },
                      );
                    })
                  }
                >
                  Cancel
                </button>
              )}
            {source.latest?.error && <span> {source.latest.error}</span>}
            {source.rate_limit_reset && (
              <span>
                {" "}
                Rate limited until{" "}
                {new Date(source.rate_limit_reset).toLocaleTimeString()}
              </span>
            )}
            {source.current_commit && (
              <span> Cached at {source.current_commit.slice(0, 8)}</span>
            )}
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
      {preview && (
        <section>
          <h3>{preview.name ?? "Invalid skill"}</h3>
          <p>
            {preview.source} at {preview.commit.slice(0, 8)} ·{" "}
            {preview.licence ?? "Licence not specified"}
          </p>
          {preview.diagnostic && (
            <p className="banner error">{preview.diagnostic}</p>
          )}
          {preview.content && (
            <Markdown>
              {preview.content.replace(
                /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                "",
              )}
            </Markdown>
          )}
          <h4>Files</h4>
          <ul>
            {preview.files.map((f) => (
              <li key={f.path}>
                {f.path} ({f.size} bytes)
              </li>
            ))}
          </ul>
          <NameField
            label="Destination name"
            value={importName}
            onChange={setImportName}
          />
          <button
            disabled={!!preview.diagnostic || !validName(importName)}
            onClick={() =>
              void act(async () => {
                await request(
                  `/api/library/sources/${preview.sourceId}/import`,
                  {
                    method: "POST",
                    body: {
                      generation: preview.generationId,
                      path: preview.path,
                      scope: "personal",
                      name: importName,
                      mode: "add",
                    },
                  },
                );
              })
            }
          >
            Add to Mine
          </button>
          {roomId && (
            <button
              disabled={!!preview.diagnostic || !validName(importName)}
              onClick={() =>
                void act(async () => {
                  await request(
                    `/api/library/sources/${preview.sourceId}/import`,
                    {
                      method: "POST",
                      body: {
                        generation: preview.generationId,
                        path: preview.path,
                        scope: "project",
                        room_id: roomId,
                        name: importName,
                        mode: "add",
                      },
                    },
                  );
                })
              }
            >
              Add to Project
            </button>
          )}
          <button
            disabled={!validName(importName)}
            onClick={() =>
              void act(async () => {
                const result = await request<{ draft_id: string }>(
                  `/api/library/sources/${preview.sourceId}/import`,
                  {
                    method: "POST",
                    body: {
                      generation: preview.generationId,
                      path: preview.path,
                      scope: "personal",
                      name: importName,
                      mode: "duplicate_fix",
                    },
                  },
                );
                const detail = await request<{
                  folder_name: string;
                  manifest: string;
                  diagnostic: string | null;
                  revision: number;
                }>(`/api/library/import-drafts/${result.draft_id}`);
                setDraft({
                  id: result.draft_id,
                  name: detail.folder_name,
                  manifest: detail.manifest,
                  diagnostic: detail.diagnostic,
                  revision: detail.revision,
                });
              })
            }
          >
            {preview.diagnostic ? "Duplicate & fix" : "Duplicate & edit"}
          </button>
        </section>
      )}
      {draft && (
        <section>
          <h3>Imported draft</h3>
          {draft.diagnostic && <p>{draft.diagnostic}</p>}
          <label>
            Name
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            SKILL.md
            <textarea
              rows={16}
              value={draft.manifest}
              onChange={(event) =>
                setDraft({ ...draft, manifest: event.target.value })
              }
            />
          </label>
          <button
            onClick={() =>
              void act(async () => {
                const changed = await request<{ revision: number }>(
                  `/api/library/import-drafts/${draft.id}`,
                  {
                    method: "PUT",
                    body: {
                      name: draft.name,
                      manifest: draft.manifest,
                      base_revision: draft.revision,
                    },
                  },
                );
                await request(`/api/library/import-drafts/${draft.id}/save`, {
                  method: "POST",
                  body: { base_revision: changed.revision },
                });
                setDraft(null);
              })
            }
          >
            Validate and save to Mine
          </button>
        </section>
      )}
    </section>
  );
}
