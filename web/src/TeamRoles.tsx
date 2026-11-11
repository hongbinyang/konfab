import { useEffect, useRef, useState } from "react";
import { request, type RoomAgent } from "./api";

type Assignment = { revision: number; notes?: string; assigned: boolean };
type Choice =
  | { from_agent_id: string }
  | { role_id: string; role_revision_id: string; notes: string }
  | { none: true };
type Row = {
  id: string;
  name: string;
  before: string;
  beforeNotes: string;
  revision: number;
  choice: Choice;
  label: string;
  notes: string;
};
type Pack = { id: string; revision_id: string; title: string };

export function TeamRoles({
  roomId,
  agents,
  selected,
  onClose,
  onApplied,
}: {
  roomId: number;
  agents: RoomAgent[];
  selected?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[][]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    id: string;
    pack: Pack;
    role_md: string;
    skills: Array<{ name: string; reviewed: number }>;
  } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void Promise.all([
      request<{ roles: Pack[] }>("/api/roles"),
      Promise.all(
        agents.map(async (agent) => {
          const { assignment } = await request<{ assignment: Assignment }>(
            `/api/rooms/${roomId}/members/${encodeURIComponent(agent.id)}/role-preview`,
          );
          return {
            id: agent.id,
            name: agent.display_name,
            before: agent.role || "No role",
            beforeNotes: assignment.notes ?? "",
            revision: assignment.revision,
            choice: { from_agent_id: agent.id },
            label: agent.role || "No role",
            notes: assignment.notes ?? "",
          };
        }),
      ),
    ])
      .then(([result, initial]) => {
        if (active) {
          setPacks(result.roles);
          setRows(initial);
          setOriginal(initial);
        }
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : "Unable to load roles");
      });
    return () => {
      active = false;
    };
    // The dialog is a snapshot; reopening refreshes it.
  }, []);
  const update = (next: Row[]) => {
    setHistory((old) => [...old, rows]);
    setRows(next);
    setError("");
  };
  const swap = (a: string, b: string) => {
    if (a === b) return;
    const first = rows.find((row) => row.id === a),
      second = rows.find((row) => row.id === b);
    if (!first || !second) return;
    update(
      rows.map((row) =>
        row.id === a
          ? {
              ...row,
              choice: second.choice,
              label: second.label,
              notes: second.notes,
            }
          : row.id === b
            ? {
                ...row,
                choice: first.choice,
                label: first.label,
                notes: first.notes,
              }
            : row,
      ),
    );
  };
  const changed = rows.filter(
    (row) =>
      !("from_agent_id" in row.choice && row.choice.from_agent_id === row.id),
  );
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await request(`/api/rooms/${roomId}/roles/reassign`, {
        method: "POST",
        body: {
          changes: rows.map((row) => ({
            agent_id: row.id,
            base_revision: row.revision,
            ...row.choice,
          })),
        },
      });
      onApplied();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to apply changes");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="team-roles"
      ref={dialog}
      aria-label="Team roles"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>Team roles</h2>
      <p>
        Drag a role to another member, or use Swap with. Room notes move with
        the role; edit access stays with the member.
      </p>
      {error && (
        <p role="alert" className="warning-text">
          {error}
        </p>
      )}
      <div className="stack">
        {rows.map((row) => (
          <section
            key={row.id}
            className="role-team-row"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              swap(event.dataTransfer.getData("text/plain"), row.id);
            }}
          >
            <strong>
              {row.name}
              {selected === row.id ? " (selected)" : ""}
            </strong>{" "}
            <button
              type="button"
              draggable
              onDragStart={(event) =>
                event.dataTransfer.setData("text/plain", row.id)
              }
              title="Drag to swap roles"
              onClick={(event) =>
                event.currentTarget.nextElementSibling
                  ?.querySelector("summary")
                  ?.click()
              }
            >
              {row.label} ⇅
            </button>
            <details>
              <summary>Role actions for {row.name}</summary>
              <label>
                Swap with{" "}
                <select
                  value=""
                  onChange={(event) => swap(row.id, event.target.value)}
                >
                  <option value="">Choose a member</option>
                  {rows
                    .filter((other) => other.id !== row.id)
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name}
                      </option>
                    ))}
                </select>
              </label>{" "}
              <label>
                Give a different role{" "}
                <select
                  value=""
                  onChange={(event) => {
                    const pack = packs.find(
                      (item) => item.id === event.target.value,
                    );
                    if (!pack) return;
                    void request<{
                      role_md: string;
                      skills: Array<{ name: string; reviewed: number }>;
                    }>(`/api/roles/${encodeURIComponent(pack.id)}`)
                      .then((detail) =>
                        setPreview({ id: row.id, pack, ...detail }),
                      )
                      .catch((e: unknown) =>
                        setError(
                          e instanceof Error
                            ? e.message
                            : "Unable to preview role",
                        ),
                      );
                  }}
                >
                  <option value="">Choose a role</option>
                  {packs.map((pack) => (
                    <option key={pack.id} value={pack.id}>
                      {pack.title}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button
                type="button"
                onClick={() =>
                  update(
                    rows.map((item) =>
                      item.id === row.id
                        ? {
                            ...item,
                            choice: { none: true },
                            label: "No role",
                            notes: "",
                          }
                        : item,
                    ),
                  )
                }
              >
                Remove role
              </button>
            </details>
            {preview?.id === row.id && (
              <div>
                <h4>Role preview</h4>
                <pre>{preview.role_md}</pre>
                {preview.skills.map((skill) => (
                  <p key={skill.name}>
                    {skill.name}:{" "}
                    {skill.reviewed
                      ? "Reviewed"
                      : "Review required in the role picker"}
                  </p>
                ))}
                <label>
                  Room notes{" "}
                  <textarea id={`team-role-notes-${row.id}`} maxLength={4000} />
                </label>{" "}
                <button
                  type="button"
                  disabled={preview.skills.some((skill) => !skill.reviewed)}
                  onClick={() => {
                    const select = (
                      document.getElementById(
                        `team-role-notes-${row.id}`,
                      ) as HTMLTextAreaElement
                    ).value;
                    const pack = preview.pack;
                    update(
                      rows.map((item) =>
                        item.id === row.id
                          ? {
                              ...item,
                              choice: {
                                role_id: pack.id,
                                role_revision_id: pack.revision_id,
                                notes: select,
                              },
                              label: pack.title,
                              notes: select,
                            }
                          : item,
                      ),
                    );
                    setPreview(null);
                  }}
                >
                  Use this role
                </button>
              </div>
            )}
            {row.notes && <p>Notes: {row.notes}</p>}
          </section>
        ))}
      </div>
      <h3>Pending changes ({changed.length})</h3>
      <ul>
        {changed.map((row) => (
          <li key={row.id}>
            {row.name}: {row.before} → {row.label}
            {row.beforeNotes !== row.notes &&
              `; notes: ${row.beforeNotes || "none"} → ${row.notes || "none"}`}
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          type="button"
          disabled={!history.length || busy}
          onClick={() => {
            setRows(history[history.length - 1]!);
            setHistory(history.slice(0, -1));
          }}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!history.length || busy}
          onClick={() => {
            setRows(original);
            setHistory([]);
          }}
        >
          Reset
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!changed.length || busy}
          onClick={() => void apply()}
        >
          Apply {changed.length} changes
        </button>
      </div>
    </dialog>
  );
}
