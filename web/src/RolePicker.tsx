import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { parseDocument } from "yaml";
import { NameField } from "./NameField";
import { suggestName, validName } from "./name-validation";
import {
  matchesPickerFilter,
  nextPickerIndex,
  pickerFilters,
  togglePickerFilter,
  type PickerFilter,
} from "./picker-filters";

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
  stage: "listing" | "descriptions" | "done" | "error";
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
  const [filters, setFilters] = useState<PickerFilter[]>([]);
  const [publicLoading, setPublicLoading] = useState(true);
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
    setPublicLoading(true);
    const poll = async () => {
      try {
        const response = await request<{
          items: PublicItem[];
          sources: SourceProgress[];
        }>(`/api/library/live?q=${encodeURIComponent(query)}`);
        if (!active) return;
        setPublicLoading(false);
        setPublicItems(response.items);
        setProgress(response.sources);
        if (response.sources.some((source) => !source.complete))
          timer = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (active) {
          setPublicLoading(false);
          setError(
            e instanceof Error ? e.message : "Public search unavailable",
          );
        }
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
    const category: PickerFilter =
      item.kind === "role"
        ? "roles"
        : item.kind === "public"
          ? "public"
          : item.scope;
    const matchesFilter = matchesPickerFilter(filters, category);
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
              instructions: customize ? instructions : undefined,
              notes,
              base_revision: baseRevision,
            },
          },
        );
        if (result.pending) {
          onAssigned();
          setBaseRevision(undefined);
          setError(
            "Assigned, but a workspace needs recovery. Restart the server to retry.",
          );
          return;
        }
      } else {
        const result = customize
          ? await request<{ pending: boolean }>(
              `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/customize-and-assign`,
              {
                method: "POST",
                body: {
                  source_scope: selected.scope,
                  scope: copyScope,
                  skill_id: selected.skill.id,
                  skill_revision: selected.skill.current_revision_id,
                  copy_name: copyName,
                  manifest: manifestDraft,
                  role_name: name,
                  title,
                  description,
                  instructions,
                  notes,
                  base_revision: baseRevision,
                },
              },
            )
          : await request<{ pending: boolean }>(
              `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/role-from-skill`,
              {
                method: "POST",
                body: {
                  scope: selected.scope,
                  skill_id: selected.skill.id,
                  skill_revision: selected.skill.current_revision_id,
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
          onAssigned();
          setBaseRevision(undefined);
          setError(
            "Assigned, but a workspace needs recovery. Restart the server to retry.",
          );
          return;
        }
      }
      onAssigned();
      onClose();
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Unable to assign the role"}`,
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
          <div className="role-picker-filters" aria-label="Filter results">
            <button
              type="button"
              aria-pressed={filters.length === 0}
              onClick={() => setFilters([])}
            >
              All
            </button>
            {pickerFilters.map(({ value, label }) => (
              <button
                type="button"
                key={value}
                aria-pressed={filters.includes(value)}
                onClick={() =>
                  setFilters((current) => togglePickerFilter(current, value))
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="role-picker-progress" aria-live="polite">
            {publicLoading && progress.length === 0 && (
              <p>Preparing public sources…</p>
            )}
            {!publicLoading && progress.length === 0 && !error && (
              <p>No public sources enabled. Enable them in Manage library.</p>
            )}
            {progress.length > 0 && (
              <p>
                {progress.some((source) => source.stage === "listing")
                  ? "Listing public sources…"
                  : `${progress.some((source) => source.stage === "error") ? "Some sources incomplete" : "Names ready"} · descriptions checked ${progress.reduce((sum, source) => sum + source.done, 0)}/${progress.reduce((sum, source) => sum + source.total, 0)}`}
              </p>
            )}
            {progress.map((source) => (
              <div key={source.source} className="source-progress">
                <span>
                  {source.source} ·{" "}
                  {source.stage === "listing"
                    ? "Listing…"
                    : source.stage === "descriptions"
                      ? `Descriptions checked ${source.done}/${source.total}`
                      : source.stage === "done"
                        ? `✓ ${source.total} skills`
                        : `Incomplete · ${source.done}/${source.total}`}
                </span>
                {source.stage === "descriptions" && source.total > 0 && (
                  <progress
                    aria-label={`${source.source} descriptions`}
                    value={source.done}
                    max={source.total}
                  />
                )}
                {source.error && (
                  <p className="source-warning">{source.error}</p>
                )}
              </div>
            ))}
          </div>
          {items.length === 0 && (
            <p>
              {publicLoading || progress.some((source) => !source.complete)
                ? "Searching sources…"
                : "No matching roles or skills."}
            </p>
          )}
          {pickerFilters.map(({ value, label }) => {
            const group = items.filter(
              (item) =>
                (item.kind === "role"
                  ? "roles"
                  : item.kind === "public"
                    ? "public"
                    : item.scope) === value,
            );
            if (!group.length) return null;
            return (
              <section className="role-picker-group" key={value}>
                <h3>{label}</h3>
                <ul className="role-picker-results">
                  {group.map((item) => {
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
                              const buttons = [
                                ...(dialog.current?.querySelectorAll<HTMLButtonElement>(
                                  ".role-picker-results button:not(:disabled)",
                                ) ?? []),
                              ];
                              const index = buttons.indexOf(
                                event.currentTarget,
                              );
                              const next = nextPickerIndex(
                                index,
                                event.key,
                                buttons.length,
                              );
                              if (next !== null) buttons[next]?.focus();
                            }
                          }}
                          aria-pressed={
                            selected !== null &&
                            resultKey(selected) === resultKey(item)
                          }
                        >
                          <strong>{label}</strong>
                          <span>
                            {item.kind === "role"
                              ? "Role"
                              : item.kind === "public"
                                ? `${item.public.source} · ${item.public.badge === "vendor" ? "Vendor-maintained" : "Community"}`
                                : item.scope === "project"
                                  ? "Project skill"
                                  : "My skill"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
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
              ((customize && (!validName(copyName) || !manifestDraft)) ||
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
