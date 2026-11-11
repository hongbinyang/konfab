import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { parseDocument } from "yaml";
import { NameField } from "./NameField";
import { suggestName, validName } from "./name-validation";

type Role = {
  id: string;
  revision_id: string;
  title: string;
  name: string;
  description: string;
  library_id: string;
};
type Skill = {
  id: string;
  current_revision_id: string;
  name: string;
  description: string;
  reviewed_at: number | null;
  licence: string | null;
};
type PublicItem = {
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
const resultKey = (item: Result): string =>
  item.kind === "role"
    ? `role:${item.role.id}`
    : item.kind === "skill"
      ? `${item.scope}:${item.skill.id}`
      : `public:${item.public.source_id}:${item.public.path}:${item.public.commit}`;
type SourceProgress = {
  source: string;
  done: number;
  total: number;
  complete: boolean;
  error: string | null;
};
type Result =
  | { kind: "public"; public: PublicItem }
  | { kind: "role"; role: Role }
  | { kind: "skill"; skill: Skill; scope: "personal" | "project" };

export function RolePicker({
  roomId,
  agentId,
  agentName,
  onClose,
  onAssigned,
}: {
  roomId: number;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const assign = useRef<HTMLButtonElement>(null);
  const selectionVersion = useRef(0);
  const focusAssignOnPreview = useRef(false);
  const [results, setResults] = useState<Result[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "roles" | "personal" | "project" | "public"
  >("all");
  const [publicItems, setPublicItems] = useState<PublicItem[]>([]);
  const [progress, setProgress] = useState<SourceProgress[]>([]);
  const [publicHash, setPublicHash] = useState("");
  const [previewLicence, setPreviewLicence] = useState<string | null>(null);
  const [selected, setSelected] = useState<Result | null>(null);
  const [preview, setPreview] = useState("");
  const [filePreview, setFilePreview] = useState("");
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [error, setError] = useState("");
  const [baseRevision, setBaseRevision] = useState<number>();
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [customize, setCustomize] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [copyScope, setCopyScope] = useState<"personal" | "project">(
    "personal",
  );
  const [manifestDraft, setManifestDraft] = useState("");
  const [copyId, setCopyId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    search.current?.focus();
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [roles, personal, assignment] = await Promise.all([
          request<{ roles: Role[] }>("/api/roles"),
          request<{ skills: Skill[] }>("/api/library?scope=personal"),
          request<{ assignment: null | { revision: number; notes: string } }>(
            `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/role-preview`,
          ),
        ]);
        let project: Skill[] = [];
        try {
          project = (
            await request<{ skills: Skill[] }>(
              `/api/library?scope=project&room_id=${roomId}`,
            )
          ).skills;
        } catch {
          /* A project library is optional. */
        }
        if (!active) return;
        setResults([
          ...roles.roles.map((role): Result => ({ kind: "role", role })),
          ...personal.skills.map((skill): Result => ({
            kind: "skill",
            skill,
            scope: "personal",
          })),
          ...project.map((skill): Result => ({
            kind: "skill",
            skill,
            scope: "project",
          })),
        ]);
        setBaseRevision(assignment.assignment?.revision ?? 0);
        setNotes(assignment.assignment?.notes ?? "");
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to load the library",
          );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [roomId, agentId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await request<{
          items: PublicItem[];
          sources: SourceProgress[];
        }>(`/api/library/live?q=${encodeURIComponent(query)}`);
        if (!active) return;
        setPublicItems(response.items);
        setProgress(response.sources);
        if (response.sources.some((source) => !source.complete))
          timer = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Public search unavailable",
          );
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [query]);
  const choose = async (item: Result) => {
    const version = ++selectionVersion.current;
    setSelected(item);
    setPreview("");
    setFilePreview("");
    setFiles([]);
    setError("");
    setCustomize(false);
    setCopyId("");
    setPublicHash("");
    setPreviewLicence(null);
    try {
      if (item.kind === "role") {
        const result = await request<{ role_md: string }>(
          `/api/roles/${encodeURIComponent(item.role.id)}`,
        );
        if (version !== selectionVersion.current) return;
        setPreview(result.role_md);
      } else if (item.kind === "public") {
        const value = item.public;
        const params = new URLSearchParams({
          source_id: value.source_id,
          commit: value.commit,
          path: value.path,
        });
        const data = await request<{
          content: string;
          preview_hash: string;
          licence: string | null;
          files: Array<{ path: string; size: number }>;
        }>(`/api/library/live/preview?${params}`);
        if (version !== selectionVersion.current) return;
        setPreview(data.content);
        setFiles(data.files);
        setPublicHash(data.preview_hash);
        setPreviewLicence(data.licence);
        const taken = new Set(
          results
            .filter((entry) => entry.kind === "role")
            .map((entry) => (entry.kind === "role" ? entry.role.name : "")),
        );
        const base = suggestName(value.name) || "skill";
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) {
          const suffix = `-${n++}`;
          candidate = `${[...base]
            .slice(0, 64 - suffix.length)
            .join("")
            .replace(/-+$/, "")}${suffix}`;
        }
        setName(candidate);
        setTitle(value.name);
        setDescription(value.description || value.name);
        setInstructions(`Follow the ${value.name} skill.`);
        const proposed = suggestName(`${value.name}-copy`);
        setCopyName(proposed);
        setCopyScope("personal");
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
          data.content,
        );
        if (match?.[1]) {
          const doc = parseDocument(match[1]);
          doc.set("name", proposed);
          setManifestDraft(
            `---\n${doc.toString()}---\n${data.content.slice(match[0].length)}`,
          );
        } else setManifestDraft(data.content);
      } else {
        const { skill } = item;
        const root = `/api/library/skills/${skill.id}/revisions/${skill.current_revision_id}`;
        const [data, listing] = await Promise.all([
          request<{ content_base64: string }>(`${root}/files?path=SKILL.md`),
          request<{ files: Array<{ path: string; size: number }> }>(root),
        ]);
        if (version !== selectionVersion.current) return;
        setPreview(
          new TextDecoder().decode(
            Uint8Array.from(atob(data.content_base64), (char) =>
              char.charCodeAt(0),
            ),
          ),
        );
        setFiles(listing.files);
        const takenSkillNames = new Set(
          results
            .filter(
              (entry) => entry.kind === "skill" && entry.scope === "personal",
            )
            .map((entry) => (entry.kind === "skill" ? entry.skill.name : "")),
        );
        const takenRoleNames = new Set(
          results
            .filter((entry) => entry.kind === "role")
            .map((entry) => (entry.kind === "role" ? entry.role.name : "")),
        );
        const freeName = (base: string, taken: Set<string>) => {
          let value = suggestName(base) || "skill";
          let n = 2;
          while (taken.has(value)) {
            const suffix = `-${n++}`;
            value = `${[...suggestName(base)]
              .slice(0, 64 - suffix.length)
              .join("")
              .replace(/-+$/, "")}${suffix}`;
          }
          return value;
        };
        const proposed = freeName(`${skill.name}-copy`, takenSkillNames);
        setCopyName(proposed);
        const original = new TextDecoder().decode(
          Uint8Array.from(atob(data.content_base64), (char) =>
            char.charCodeAt(0),
          ),
        );
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original);
        if (match?.[1]) {
          const doc = parseDocument(match[1]);
          doc.set("name", proposed);
          setManifestDraft(
            `---\n${doc.toString()}---\n${original.slice(match[0].length)}`,
          );
        } else setManifestDraft(original);
        setName(freeName(skill.name, takenRoleNames));
        setTitle(skill.name);
        setDescription(skill.description);
        setInstructions(`Follow the ${skill.name} skill.`);
      }
    } catch (e) {
      if (version === selectionVersion.current)
        setError(e instanceof Error ? e.message : "Unable to load the preview");
    }
  };
  useEffect(() => {
    if (preview && focusAssignOnPreview.current) {
      focusAssignOnPreview.current = false;
      assign.current?.focus();
    }
  }, [preview]);
  const items: Result[] = [
    ...results,
    ...publicItems.map((item): Result => ({ kind: "public", public: item })),
  ].filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "roles"
        ? item.kind === "role"
        : filter === "public"
          ? item.kind === "public"
          : item.kind === "skill" && item.scope === filter);
    const text =
      item.kind === "role"
        ? `${item.role.title} ${item.role.description}`
        : item.kind === "public"
          ? `${item.public.path} ${item.public.name} ${item.public.description ?? ""}`
          : `${item.skill.name} ${item.skill.description}`;
    return matchesFilter && text.toLowerCase().includes(query.toLowerCase());
  });
  const submit = async () => {
    if (!selected || !preview || baseRevision === undefined) return;
    setBusy(true);
    setError("");
    let madeCopy = false;
    try {
      if (selected.kind === "role")
        await request(
          `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/role-pack`,
          {
            method: "PUT",
            body: {
              role_id: selected.role.id,
              role_revision_id: selected.role.revision_id,
              notes,
              base_revision: baseRevision,
            },
          },
        );
      else if (selected.kind === "public") {
        const item = selected.public;
        const result = await request<{ pending: boolean }>(
          `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/role-from-public`,
          {
            method: "POST",
            body: {
              source_id: item.source_id,
              commit: item.commit,
              path: item.path,
              preview_hash: publicHash,
              scope: customize ? copyScope : "personal",
              custom_manifest: customize ? manifestDraft : undefined,
              copy_name: customize ? copyName : undefined,
              role_name: name,
              title,
              description,
              notes,
              base_revision: baseRevision,
            },
          },
        );
        if (result.pending) {
          setError("Assigned, but the role folder needs recovery.");
          return;
        }
      } else {
        let skillId = selected.skill.id;
        let skillRevision = selected.skill.current_revision_id;
        let scope = selected.scope;
        if (customize) {
          if (!validName(copyName))
            throw new Error("Enter a valid name for the skill copy.");
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
            manifestDraft,
          );
          if (!match?.[1]) throw new Error("The skill needs YAML frontmatter.");
          const doc = parseDocument(match[1]);
          if (doc.errors.length || doc.get("name") !== copyName)
            throw new Error("The SKILL.md name must match the copy name.");
          if (copyId)
            throw new Error(
              `A copy was already created. Open it in Manage library to finish or remove it: ${copyName}.`,
            );
          await request(
            `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/picker-preflight`,
            {
              method: "POST",
              body: { scope: copyScope, role_name: name, skill_name: copyName },
            },
          );
          const copied = await request<{ id: string }>(
            `/api/library/skills/${skillId}/duplicate`,
            {
              method: "POST",
              body: {
                revision_id: skillRevision,
                scope: copyScope,
                room_id: copyScope === "project" ? roomId : undefined,
                name: copyName,
              },
            },
          );
          madeCopy = true;
          setCopyId(copied.id);
          skillId = copied.id;
          scope = copyScope;
          const detail = await request<{
            current_revision_id: string;
            draft_hash: string;
          }>(`/api/library/skills/${skillId}`);
          const bytes = new TextEncoder().encode(manifestDraft);
          let binary = "";
          for (let index = 0; index < bytes.length; index += 8192)
            binary += String.fromCharCode(
              ...bytes.subarray(index, index + 8192),
            );
          const content = btoa(binary);
          const written = await request<{ draft_hash: string }>(
            `/api/library/skills/${skillId}/files`,
            {
              method: "PUT",
              body: {
                path: "SKILL.md",
                content_base64: content,
                base_revision_id: detail.current_revision_id,
                base_draft_hash: detail.draft_hash,
              },
            },
          );
          const saved = await request<{ revision_id: string }>(
            `/api/library/skills/${skillId}/save`,
            {
              method: "POST",
              body: {
                base_revision_id: detail.current_revision_id,
                base_draft_hash: written.draft_hash,
              },
            },
          );
          skillRevision = saved.revision_id;
          await request(
            `/api/library/skills/${skillId}/reviews/${skillRevision}`,
            { method: "PUT" },
          );
        }
        const result = await request<{ pending: boolean }>(
          `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/role-from-skill`,
          {
            method: "POST",
            body: {
              scope,
              skill_id: skillId,
              skill_revision: skillRevision,
              name,
              title,
              description,
              instructions,
              notes,
              base_revision: baseRevision,
              review: true,
            },
          },
        );
        if (result.pending) {
          setError(
            "Assigned, but the role folder needs recovery. Reopen the library to check it.",
          );
          return;
        }
      }
      onAssigned();
      onClose();
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Unable to assign the role"}${madeCopy ? " A skill copy was saved; find it in the library to finish or remove it." : ""}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="role-picker"
      aria-labelledby="role-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id="role-picker-title">Choose a role for {agentName}</h2>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      <div className="role-picker-columns">
        <section>
          <label>
            Search roles and skills
            <input
              ref={search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div aria-label="Filter results">
            {(
              [
                ["all", "All"],
                ["roles", "My roles"],
                ["personal", "My skills"],
                ["project", "Project"],
                ["public", "Public"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {progress.map((source) => (
            <p key={source.source} role="status">
              {source.error
                ? `${source.source}: ${source.error}`
                : !source.complete
                  ? `Searching ${source.source} descriptions… ${source.done}/${source.total}`
                  : ""}
            </p>
          ))}
          {items.length === 0 && <p>No matching roles or skills.</p>}
          <ul>
            {items.map((item) => {
              const id =
                item.kind === "role"
                  ? item.role.id
                  : item.kind === "public"
                    ? `${item.public.source_id}:${item.public.path}`
                    : `${item.scope}:${item.skill.id}`;
              const label =
                item.kind === "role"
                  ? item.role.title
                  : item.kind === "public"
                    ? item.public.name
                    : item.skill.name;
              return (
                <li key={id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void choose(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (
                          selected &&
                          resultKey(selected) === resultKey(item) &&
                          preview
                        )
                          assign.current?.focus();
                        else {
                          focusAssignOnPreview.current = true;
                          void choose(item);
                        }
                      } else if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp"
                      ) {
                        event.preventDefault();
                        const sibling =
                          event.key === "ArrowDown"
                            ? event.currentTarget.parentElement
                                ?.nextElementSibling
                            : event.currentTarget.parentElement
                                ?.previousElementSibling;
                        sibling
                          ?.querySelector<HTMLButtonElement>("button")
                          ?.focus();
                      }
                    }}
                    aria-pressed={
                      selected !== null &&
                      resultKey(selected) === resultKey(item)
                    }
                  >
                    {label} ·{" "}
                    {item.kind === "role"
                      ? "Role"
                      : item.kind === "public"
                        ? `Public · ${item.public.source}`
                        : item.scope === "project"
                          ? "Project skill"
                          : "My skill"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3>Preview</h3>
          {!selected ? (
            <p>Select a role or skill to preview it.</p>
          ) : (
            <>
              <pre>{preview || "Loading…"}</pre>
              {files.length > 0 && (
                <ul>
                  {files.map((file) => (
                    <li key={file.path}>
                      {file.path} ({file.size} bytes){" "}
                      {(selected.kind === "skill" ||
                        selected.kind === "public") && (
                        <button
                          type="button"
                          onClick={() =>
                            void (async () => {
                              try {
                                const url =
                                  selected.kind === "skill"
                                    ? `/api/library/skills/${selected.skill.id}/revisions/${selected.skill.current_revision_id}/files?path=${encodeURIComponent(file.path)}`
                                    : selected.kind === "public"
                                      ? `/api/library/live/file?${new URLSearchParams({ source_id: selected.public.source_id, commit: selected.public.commit, path: selected.public.path, file: file.path })}`
                                      : "";
                                const data = await request<{
                                  content_base64: string;
                                }>(url);
                                setFilePreview(
                                  new TextDecoder().decode(
                                    Uint8Array.from(
                                      atob(data.content_base64),
                                      (char) => char.charCodeAt(0),
                                    ),
                                  ),
                                );
                              } catch (e) {
                                setError(
                                  e instanceof Error
                                    ? e.message
                                    : "Unable to load file",
                                );
                              }
                            })()
                          }
                        >
                          View
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {filePreview && <pre>{filePreview}</pre>}
              {selected.kind === "public" && (
                <p>
                  Public · {selected.public.source} ·{" "}
                  {selected.public.commit.slice(0, 12)} · Licence:{" "}
                  {previewLicence ?? "Not specified"}. Preview only; the skill
                  is saved when assigned.
                </p>
              )}
              {(selected.kind === "skill" ||
                (selected.kind === "public" && customize)) && (
                <>
                  {selected.kind === "skill" && (
                    <p>
                      Licence: {selected.skill.licence ?? "Not specified"} ·{" "}
                      {selected.skill.reviewed_at
                        ? "Reviewed"
                        : "Review required"}
                    </p>
                  )}
                  {selected.kind === "skill" && !selected.skill.reviewed_at && (
                    <button
                      type="button"
                      disabled={!preview || busy}
                      onClick={() =>
                        void (async () => {
                          try {
                            await request(
                              `/api/library/skills/${selected.skill.id}/reviews/${selected.skill.current_revision_id}`,
                              { method: "PUT" },
                            );
                            const updated = {
                              ...selected,
                              skill: {
                                ...selected.skill,
                                reviewed_at: Date.now(),
                              },
                            };
                            setSelected(updated);
                            setResults((current) =>
                              current.map((item) =>
                                item.kind === "skill" &&
                                item.skill.id === selected.skill.id
                                  ? updated
                                  : item,
                              ),
                            );
                          } catch (e) {
                            setError(
                              e instanceof Error
                                ? e.message
                                : "Unable to mark reviewed",
                            );
                          }
                        })()
                      }
                    >
                      Mark this revision reviewed
                    </button>
                  )}
                  {customize && (
                    <>
                      <NameField
                        label="Skill copy name"
                        value={copyName}
                        onChange={(value) => {
                          setCopyName(value);
                          const match =
                            /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
                              manifestDraft,
                            );
                          if (match?.[1]) {
                            const doc = parseDocument(match[1]);
                            if (!doc.errors.length) {
                              doc.set("name", value);
                              setManifestDraft(
                                `---\n${doc.toString()}---\n${manifestDraft.slice(match[0].length)}`,
                              );
                            }
                          }
                        }}
                      />
                      <label>
                        Save skill to
                        <select
                          value={copyScope}
                          onChange={(event) =>
                            setCopyScope(
                              event.target.value as "personal" | "project",
                            )
                          }
                        >
                          <option value="personal">Mine</option>
                          <option value="project">This project</option>
                        </select>
                      </label>
                      <label>
                        Skill instructions (SKILL.md)
                        <textarea
                          value={manifestDraft}
                          onChange={(event) =>
                            setManifestDraft(event.target.value)
                          }
                        />
                      </label>
                      <p>
                        Saving marks this displayed skill revision as reviewed
                        and creates a separate copy.
                      </p>
                      <NameField
                        label="Role name"
                        value={name}
                        onChange={setName}
                      />
                      <label>
                        Title
                        <input
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                        />
                      </label>
                      <label>
                        Description
                        <input
                          value={description}
                          onChange={(event) =>
                            setDescription(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        Role instructions
                        <textarea
                          value={instructions}
                          onChange={(event) =>
                            setInstructions(event.target.value)
                          }
                        />
                      </label>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
      <footer>
        {(selected?.kind === "skill" || selected?.kind === "public") && (
          <button type="button" onClick={() => setCustomize(!customize)}>
            {customize ? "Back to preview" : "Customize"}
          </button>
        )}
        <button
          ref={assign}
          type="button"
          disabled={
            busy ||
            !selected ||
            !preview ||
            baseRevision === undefined ||
            (selected.kind === "public" &&
              (!publicHash ||
                !validName(name) ||
                (customize && (!validName(copyName) || !manifestDraft)))) ||
            (selected.kind === "skill" &&
              ((customize &&
                (!validName(copyName) || !manifestDraft || !!copyId)) ||
                !validName(name) ||
                !title.trim() ||
                !description.trim()))
          }
          onClick={() => void submit()}
        >
          {customize
            ? "Save and assign"
            : selected?.kind === "public" ||
                (selected?.kind === "skill" && !selected.skill.reviewed_at)
              ? `Review & assign to ${agentName}`
              : `Assign to ${agentName}`}
        </button>
      </footer>
    </dialog>
  );
}
