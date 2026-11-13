import { useEffect, useMemo, useRef, useState } from "react";
import { request, RequestError } from "./api";
import { suggestName } from "./name-validation";
import {
  matchesPickerFilter,
  nextPickerIndex,
  pickerEmpty,
  pickerFilters,
  pickerHint,
  togglePickerFilter,
  type PickerFilter,
  type PickerLocations,
} from "./picker-filters";

type Scope = "personal" | "project" | "builtin";
type LibrarySkill = {
  id: string;
  current_revision_id: string;
  name: string;
  number?: number;
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
};
type SourceProgress = {
  source: string;
  done: number;
  total: number;
  complete: boolean;
  stage: "listing" | "descriptions" | "done" | "error";
  error: string | null;
};
type Result =
  | { kind: "skill"; skill: LibrarySkill; scope: Scope }
  | { kind: "public"; public: PublicItem };

export type Delivery = "full" | "summary";
/** One selected skill, in order. Public skills are copied locally only when the assignment is confirmed. */
export type Pick =
  | {
      kind: "local";
      skill_id: string;
      revision_id: string;
      name: string;
      number: number | null;
      delivery: Delivery;
      reviewed: boolean;
      source: string;
      latest: { id: string; number: number } | null;
      bytes: number | null;
    }
  | {
      kind: "public";
      source_id: string;
      commit: string;
      path: string;
      preview_hash: string;
      name: string;
      delivery: Delivery;
      source: string;
      bytes: number;
      keep_local?: boolean;
      copy_name?: string;
    };
export type Selection = { instructions: string; pins: Pick[] };

type CurrentAssignment = {
  revision: number;
  instructions: string;
  limit: number;
  skills: Array<{
    skill_id: string;
    revision_id: string;
    name: string;
    number: number;
    delivery: Delivery;
    reviewed: boolean;
    latest: { id: string; number: number; reviewed: number } | null;
  }>;
};

const decode = (base64: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
const resultKey = (item: Result) =>
  item.kind === "public"
    ? `public:${item.public.source_id}:${item.public.path}:${item.public.commit}`
    : `${item.scope}:${item.skill.id}`;
const pickKey = (pick: Pick) =>
  pick.kind === "public"
    ? `public:${pick.source_id}:${pick.path}`
    : `skill:${pick.skill_id}`;
const SCOPE_LABEL: Record<Scope, string> = {
  personal: "My skill",
  project: "Project skill",
  builtin: "Built-in",
};
/** Lines removed from and added to a SKILL.md between two revisions. */
export function lineDiff(before: string, after: string) {
  const old = before.split("\n");
  const next = after.split("\n");
  const kept = new Set(old.filter((line) => next.includes(line)));
  return [
    ...old
      .filter((line) => !kept.has(line))
      .map((line) => ({ kind: "removed" as const, line })),
    ...next
      .filter((line) => !old.includes(line))
      .map((line) => ({ kind: "added" as const, line })),
  ];
}

/** The request form of a selection's pins. */
export function requestPins(pins: Pick[]) {
  return pins.map((pin) =>
    pin.kind === "local"
      ? {
          skill_id: pin.skill_id,
          revision_id: pin.revision_id,
          delivery: pin.delivery,
        }
      : {
          public: {
            source_id: pin.source_id,
            commit: pin.commit,
            path: pin.path,
            preview_hash: pin.preview_hash,
            ...(pin.keep_local ? { keep_local: true } : {}),
            ...(pin.copy_name ? { copy_name: pin.copy_name } : {}),
          },
          delivery: pin.delivery,
        },
  );
}

/** Revisions that confirming this selection reviews (public copies are reviewed by the server). */
export function reviewIds(pins: Pick[]) {
  return pins.flatMap((pin) =>
    pin.kind === "local" && !pin.reviewed ? [pin.revision_id] : [],
  );
}

/**
 * Choose an agent's skills in one room: search, preview, add, order, choose
 * full text or summary, and write room instructions. In member mode it saves
 * the assignment; with `initial` and `onChoose` it returns the selection
 * (used when adding an agent).
 */
export function AssignSkills({
  roomId,
  agentId,
  agentName,
  initial,
  onChoose,
  onClose,
  onAssigned,
}: {
  roomId: number;
  agentId?: string;
  agentName: string;
  initial?: Selection;
  onChoose?: (selection: Selection) => void;
  onClose: () => void;
  onAssigned?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selectionVersion = useRef(0);
  const [results, setResults] = useState<Result[]>([]);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<PickerFilter[]>([]);
  const [locations, setLocations] = useState<PickerLocations | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [projectUnavailable, setProjectUnavailable] = useState(false);
  const [publicLoading, setPublicLoading] = useState(true);
  const [publicItems, setPublicItems] = useState<PublicItem[]>([]);
  const [progress, setProgress] = useState<SourceProgress[]>([]);
  const [selected, setSelected] = useState<Result | null>(null);
  const [preview, setPreview] = useState("");
  const [previewHash, setPreviewHash] = useState("");
  const [previewLicence, setPreviewLicence] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [pins, setPins] = useState<Pick[]>(initial?.pins ?? []);
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [baseRevision, setBaseRevision] = useState<number | undefined>(
    agentId ? undefined : 0,
  );
  const [limit, setLimit] = useState(64 * 1024);
  const [bytes, setBytes] = useState<number | null>(null);
  const [diffs, setDiffs] = useState<
    Record<string, ReturnType<typeof lineDiff> | "loading">
  >({});
  const [conflict, setConflict] = useState<null | {
    index: number;
    message: string;
  }>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    search.current?.focus();
    return () => {
      if (el?.open) el.close();
    };
  }, []);

  // The library, and the member's current assignment.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [personal, builtin, locationsResult, current] = await Promise.all(
          [
            request<{ skills: LibrarySkill[] }>("/api/library?scope=personal"),
            request<{ skills: LibrarySkill[] }>("/api/library/builtin").catch(
              () => ({ skills: [] }),
            ),
            request<PickerLocations>(
              `/api/rooms/${roomId}/picker-locations`,
            ).catch(() => null),
            agentId
              ? request<CurrentAssignment>(
                  `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/assignment`,
                )
              : Promise.resolve(null),
          ],
        );
        let project: LibrarySkill[] = [];
        let projectError = false;
        try {
          const response = await request<{
            skills: LibrarySkill[];
            unavailable?: boolean;
          }>(`/api/library?scope=project&room_id=${roomId}`);
          project = response.skills;
          projectError = !!response.unavailable;
        } catch {
          projectError = true;
        }
        if (!active) return;
        setResults([
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
          ...builtin.skills.map((skill): Result => ({
            kind: "skill",
            skill,
            scope: "builtin",
          })),
        ]);
        setProjectUnavailable(projectError);
        setLocations(locationsResult);
        if (current) {
          setBaseRevision(current.revision);
          setLimit(current.limit);
          setInstructions(current.instructions);
          setPins(
            current.skills.map((skill): Pick => ({
              kind: "local",
              skill_id: skill.skill_id,
              revision_id: skill.revision_id,
              name: skill.name,
              number: skill.number,
              delivery: skill.delivery,
              reviewed: skill.reviewed,
              source: "Assigned",
              latest:
                skill.latest && skill.latest.id !== skill.revision_id
                  ? { id: skill.latest.id, number: skill.latest.number }
                  : null,
              bytes: null,
            })),
          );
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to load the library",
          );
      } finally {
        if (active) setLibraryLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [roomId, agentId]);

  // Public search; names arrive first and descriptions fill in.
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

  // The size the agent will receive, measured by the server for local skills.
  const localPins = useMemo(
    () =>
      pins.flatMap((pin) =>
        pin.kind === "local"
          ? [
              {
                skill_id: pin.skill_id,
                revision_id: pin.revision_id,
                delivery: pin.delivery,
              },
            ]
          : [],
      ),
    [pins],
  );
  const publicBytes = pins.reduce(
    (sum, pin) =>
      pin.kind === "public"
        ? sum + (pin.delivery === "full" ? pin.bytes : 300)
        : sum,
    0,
  );
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void request<{ bytes: number; limit: number }>(
        `/api/rooms/${roomId}/members/${encodeURIComponent(agentId ?? "_")}/assignment/size`,
        { method: "POST", body: { instructions, pins: localPins } },
      )
        .then((result) => {
          if (!active) return;
          setBytes(result.bytes);
          setLimit(result.limit);
        })
        .catch(() => {
          if (active) setBytes(null);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [roomId, agentId, instructions, localPins]);
  const total = bytes === null ? null : bytes + publicBytes;
  const over = total !== null && total > limit;

  const choose = async (item: Result) => {
    const version = ++selectionVersion.current;
    setSelected(item);
    setPreview("");
    setPreviewHash("");
    setPreviewLicence(null);
    setFiles([]);
    try {
      if (item.kind === "public") {
        const params = new URLSearchParams({
          source_id: item.public.source_id,
          commit: item.public.commit,
          path: item.public.path,
        });
        const data = await request<{
          content: string;
          preview_hash: string;
          licence: string | null;
          files: Array<{ path: string; size: number }>;
        }>(`/api/library/live/preview?${params}`);
        if (version !== selectionVersion.current) return;
        setPreview(data.content);
        setPreviewHash(data.preview_hash);
        setPreviewLicence(data.licence);
        setFiles(data.files);
      } else {
        const root = `/api/library/skills/${encodeURIComponent(item.skill.id)}/revisions/${item.skill.current_revision_id}`;
        const [data, listing] = await Promise.all([
          request<{ content_base64: string }>(`${root}/files?path=SKILL.md`),
          request<{ files: Array<{ path: string; size: number }> }>(root),
        ]);
        if (version !== selectionVersion.current) return;
        setPreview(decode(data.content_base64));
        setFiles(listing.files);
      }
    } catch (e) {
      if (version === selectionVersion.current)
        setError(e instanceof Error ? e.message : "Unable to load the preview");
    }
  };

  const toPick = (item: Result): Pick | null => {
    if (item.kind === "public") {
      if (!previewHash || selected?.kind !== "public") return null;
      return {
        kind: "public",
        source_id: item.public.source_id,
        commit: item.public.commit,
        path: item.public.path,
        preview_hash: previewHash,
        name: item.public.name,
        delivery: "full",
        source: item.public.source,
        bytes: new TextEncoder().encode(preview).length + 400,
      };
    }
    return {
      kind: "local",
      skill_id: item.skill.id,
      revision_id: item.skill.current_revision_id,
      name: item.skill.name,
      number: item.skill.number ?? null,
      delivery: "full",
      reviewed: !!item.skill.reviewed_at,
      source: SCOPE_LABEL[item.scope],
      latest: null,
      bytes: null,
    };
  };
  const chosen = new Set(pins.map(pickKey));
  const isChosen = (item: Result) =>
    chosen.has(
      item.kind === "public"
        ? `public:${item.public.source_id}:${item.public.path}`
        : `skill:${item.skill.id}`,
    );
  const add = (item: Result) => {
    const pick = toPick(item);
    if (!pick || chosen.has(pickKey(pick))) return;
    setPins((current) => [...current, pick]);
  };
  const update = (index: number, change: Partial<Pick>) =>
    setPins((current) =>
      current.map((pin, i) =>
        i === index ? ({ ...pin, ...change } as Pick) : pin,
      ),
    );
  const move = (index: number, by: -1 | 1) =>
    setPins((current) => {
      const next = [...current];
      const [pin] = next.splice(index, 1);
      next.splice(index + by, 0, pin!);
      return next;
    });
  const dropDiff = (key: string) =>
    setDiffs((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const showDiff = async (pin: Extract<Pick, { kind: "local" }>) => {
    const key = pin.skill_id;
    if (diffs[key]) {
      dropDiff(key);
      return;
    }
    setDiffs((current) => ({ ...current, [key]: "loading" }));
    try {
      const file = (revision: string) =>
        request<{ content_base64: string }>(
          `/api/library/skills/${encodeURIComponent(pin.skill_id)}/revisions/${revision}/files?path=SKILL.md`,
        ).then((data) => decode(data.content_base64));
      const [before, after] = await Promise.all([
        file(pin.revision_id),
        file(pin.latest!.id),
      ]);
      setDiffs((current) => ({ ...current, [key]: lineDiff(before, after) }));
    } catch (e) {
      dropDiff(key);
      setError(e instanceof Error ? e.message : "Unable to load changes");
    }
  };

  const unreviewed = pins.filter(
    (pin): pin is Extract<Pick, { kind: "local" }> =>
      pin.kind === "local" && !pin.reviewed,
  );
  const publicPins = pins.filter((pin) => pin.kind === "public");
  const submit = async () => {
    setError("");
    if (onChoose) {
      onChoose({ instructions, pins });
      onClose();
      return;
    }
    if (baseRevision === undefined || !agentId) return;
    setBusy(true);
    try {
      await request(
        `/api/rooms/${roomId}/members/${encodeURIComponent(agentId)}/assignment`,
        {
          method: "PUT",
          body: {
            base_revision: baseRevision,
            instructions,
            pins: requestPins(pins),
            review: reviewIds(pins),
          },
        },
      );
      onAssigned?.();
      onClose();
    } catch (e) {
      if (
        e instanceof RequestError &&
        (e.code === "local_changes" || e.code === "name_conflict") &&
        typeof e.details.pin === "number"
      )
        setConflict({ index: e.details.pin, message: e.message });
      else setError(e instanceof Error ? e.message : "Unable to assign");
    } finally {
      setBusy(false);
    }
  };

  const items: Result[] = [
    ...results,
    ...publicItems.map((item): Result => ({ kind: "public", public: item })),
  ].filter((item) => {
    const category: PickerFilter =
      item.kind === "public" ? "public" : item.scope;
    const text =
      item.kind === "public"
        ? `${item.public.path} ${item.public.name} ${item.public.description ?? ""}`
        : `${item.skill.name} ${item.skill.description}`;
    return (
      matchesPickerFilter(filters, category) &&
      text.toLowerCase().includes(query.toLowerCase())
    );
  });
  const searching =
    publicLoading || progress.some((source) => !source.complete);
  const kib = (value: number) => `${(value / 1024).toFixed(1)} KiB`;
  const conflictPin = conflict ? pins[conflict.index] : undefined;

  return (
    <dialog
      ref={dialog}
      className="role-picker assign-skills"
      aria-labelledby="assign-skills-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id="assign-skills-title">Assign skills · {agentName}</h2>
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
        <section aria-label="Find skills">
          <label>
            Search skills
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
                title={pickerHint(value, locations)}
                aria-pressed={filters.includes(value)}
                onClick={() =>
                  setFilters((current) => togglePickerFilter(current, value))
                }
              >
                {label}
              </button>
            ))}
          </div>
          {matchesPickerFilter(filters, "public") && progress.length > 0 && (
            <p className="muted" aria-live="polite">
              {progress.some((source) => source.stage === "listing")
                ? "Listing public sources…"
                : `Public descriptions checked ${progress.reduce((sum, source) => sum + source.done, 0)}/${progress.reduce((sum, source) => sum + source.total, 0)}`}
            </p>
          )}
          {items.length === 0 && (
            <p className="muted">
              {libraryLoading || searching
                ? "Searching…"
                : query.trim()
                  ? `No matches for “${query.trim()}”.`
                  : "No skills available."}
            </p>
          )}
          {pickerFilters.map(({ value, label }) => {
            const group = items.filter(
              (item) =>
                (item.kind === "public" ? "public" : item.scope) === value,
            );
            if (!group.length)
              return !query.trim() && filters.includes(value) ? (
                <section className="role-picker-group" key={value}>
                  <h3>{label}</h3>
                  <p className="muted">
                    {value === "project" && projectUnavailable
                      ? "Project library unavailable. Check the project folder."
                      : pickerEmpty(value, query, !!locations?.project)}
                  </p>
                </section>
              ) : null;
            return (
              <section className="role-picker-group" key={value}>
                <h3>{label}</h3>
                <ul className="role-picker-results">
                  {group.map((item) => {
                    const name =
                      item.kind === "public"
                        ? item.public.name
                        : item.skill.name;
                    const added = isChosen(item);
                    return (
                      <li key={resultKey(item)}>
                        <button
                          type="button"
                          disabled={busy}
                          aria-pressed={
                            selected !== null &&
                            resultKey(selected) === resultKey(item)
                          }
                          onClick={() => void choose(item)}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "ArrowDown" &&
                              event.key !== "ArrowUp"
                            )
                              return;
                            event.preventDefault();
                            const buttons = [
                              ...(dialog.current?.querySelectorAll<HTMLButtonElement>(
                                ".role-picker-results button.result:not(:disabled)",
                              ) ?? []),
                            ];
                            const next = nextPickerIndex(
                              buttons.indexOf(event.currentTarget),
                              event.key,
                              buttons.length,
                            );
                            if (next !== null) buttons[next]?.focus();
                          }}
                          className="result"
                        >
                          <strong>{name}</strong>
                          <span>
                            {item.kind === "public"
                              ? `${item.public.source} · ${item.public.badge === "vendor" ? "Vendor-maintained" : "Community"}`
                              : SCOPE_LABEL[item.scope]}
                            {added ? " · Added" : ""}
                          </span>
                        </button>
                        {item.kind === "skill" && !added && (
                          <button
                            type="button"
                            className="secondary"
                            aria-label={`Add ${name}`}
                            disabled={busy}
                            onClick={() => add(item)}
                          >
                            Add
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <section aria-label="Preview">
            <h3>Preview</h3>
            {!selected ? (
              <p className="muted">Select a skill to preview it.</p>
            ) : (
              <>
                <pre>{preview || "Loading…"}</pre>
                {files.length > 0 && (
                  <p className="muted">
                    Files:{" "}
                    {files
                      .map((file) => `${file.path} (${file.size} bytes)`)
                      .join(", ")}
                  </p>
                )}
                {selected.kind === "public" && (
                  <p className="muted">
                    {selected.public.source} ·{" "}
                    {selected.public.commit.slice(0, 12)} · Licence:{" "}
                    {previewLicence ?? "Not specified"}. Nothing is saved until
                    you assign; assigning copies it to your library.
                  </p>
                )}
                <button
                  type="button"
                  disabled={
                    busy ||
                    !preview ||
                    (selected.kind === "public" && !previewHash) ||
                    isChosen(selected)
                  }
                  onClick={() => add(selected)}
                >
                  Add to selection
                </button>
              </>
            )}
          </section>
        </section>
        <section aria-label="Selected skills">
          <h3>Selected, in order</h3>
          <p className="muted">
            The agent follows room rules and your instructions first, then these
            skills in this order. When skills conflict, the earlier one wins.
          </p>
          {pins.length === 0 ? (
            <p className="muted">
              No skills selected. The agent gets only room instructions, if any.
            </p>
          ) : (
            <ol className="assign-selected">
              {pins.map((pin, index) => {
                const diff =
                  pin.kind === "local" ? diffs[pin.skill_id] : undefined;
                return (
                  <li key={pickKey(pin)}>
                    <div className="row">
                      <strong>
                        {pin.name}{" "}
                        {pin.kind === "local"
                          ? pin.number
                            ? `rev ${pin.number}`
                            : ""
                          : "(copied on assign)"}
                      </strong>
                      <span className="muted">{pin.source}</span>
                      <button
                        type="button"
                        aria-label={`Move ${pin.name} up`}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${pin.name} down`}
                        disabled={busy || index === pins.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${pin.name}`}
                        disabled={busy}
                        onClick={() =>
                          setPins((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        ✕
                      </button>
                    </div>
                    <div className="row">
                      <span
                        className="segmented"
                        role="group"
                        aria-label={`How ${pin.name} is sent`}
                      >
                        <button
                          type="button"
                          aria-pressed={pin.delivery === "full"}
                          onClick={() => update(index, { delivery: "full" })}
                        >
                          Full text
                        </button>
                        <button
                          type="button"
                          aria-pressed={pin.delivery === "summary"}
                          onClick={() => update(index, { delivery: "summary" })}
                        >
                          Summary
                        </button>
                      </span>
                      {pin.kind === "public" ? (
                        <span className="chip">
                          Not reviewed — confirming reviews it
                        </span>
                      ) : pin.reviewed ? (
                        <span className="chip">Reviewed</span>
                      ) : (
                        <span className="chip warning">
                          Not reviewed — confirming reviews it
                        </span>
                      )}
                    </div>
                    {pin.kind === "local" && pin.latest && (
                      <div className="row">
                        <span className="chip warning">
                          rev {pin.latest.number} available
                        </span>
                        <button
                          type="button"
                          className="link"
                          onClick={() => void showDiff(pin)}
                        >
                          {diff ? "Hide changes" : "Show changes"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            update(index, {
                              revision_id: pin.latest!.id,
                              number: pin.latest!.number,
                              latest: null,
                              reviewed: false,
                            });
                            dropDiff(pin.skill_id);
                          }}
                        >
                          Use rev {pin.latest.number}
                        </button>
                      </div>
                    )}
                    {diff === "loading" && <p className="muted">Loading…</p>}
                    {Array.isArray(diff) && (
                      <pre className="diff" aria-label="Changes">
                        {diff.length === 0
                          ? "No changes to SKILL.md."
                          : diff
                              .map(
                                (entry) =>
                                  `${entry.kind === "added" ? "+" : "-"} ${entry.line}`,
                              )
                              .join("\n")}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <label>
            Room instructions (only in this room)
            <textarea
              value={instructions}
              maxLength={6000}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <p className="muted" aria-live="polite">
            Size the agent receives:{" "}
            {total === null
              ? "measuring…"
              : `${publicPins.length ? "about " : ""}${kib(total)} of ${kib(limit)}`}
          </p>
          <progress
            className={over ? "over" : undefined}
            aria-label="Assignment size"
            value={Math.min(total ?? 0, limit)}
            max={limit}
          />
          {over && (
            <p className="banner error" role="alert">
              These skills total {kib(total!)}; agents can receive up to{" "}
              {kib(limit)}. Switch a skill to Summary, remove one, or move long
              material out of SKILL.md into supporting files.
            </p>
          )}
        </section>
      </div>
      {conflict && conflictPin?.kind === "public" && (
        <div className="banner warning" role="alertdialog">
          <p>{conflict.message}</p>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                update(conflict.index, {
                  keep_local: true,
                  copy_name: undefined,
                });
                setConflict(null);
              }}
            >
              Keep my version
            </button>
            <button
              type="button"
              onClick={() => {
                update(conflict.index, {
                  keep_local: false,
                  copy_name: suggestName(`${conflictPin.name}-2`),
                });
                setConflict(null);
              }}
            >
              Add as {suggestName(`${conflictPin.name}-2`)}
            </button>
          </div>
        </div>
      )}
      <footer>
        <span className="muted">
          {over
            ? "Too large to send: switch a skill to Summary or remove one."
            : unreviewed.length || publicPins.length
              ? `Confirming marks ${[...unreviewed, ...publicPins].map((pin) => pin.name).join(", ")} as reviewed.`
              : "Applies from the agent's next turn."}
        </span>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || over || baseRevision === undefined}
          onClick={() => void submit()}
        >
          {onChoose
            ? `Use these ${pins.length} skill${pins.length === 1 ? "" : "s"}`
            : `Assign ${pins.length} skill${pins.length === 1 ? "" : "s"} to ${agentName}`}
        </button>
      </footer>
    </dialog>
  );
}
