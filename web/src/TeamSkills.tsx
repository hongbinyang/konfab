import { useEffect, useRef, useState } from "react";
import { request, type RoomAgent } from "./api";

type Choice = { from_agent_id: string } | { none: true };
type Row = {
  id: string;
  name: string;
  before: string;
  revision: number;
  choice: Choice;
  label: string;
  instructions: string;
};

/**
 * Moves whole skill bundles (skills and room instructions) between members in
 * one change. Names, apps and edit permission stay with each member.
 */
export function TeamSkills({
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
  const [original] = useState<Row[]>(() =>
    agents.map((agent) => ({
      id: agent.id,
      name: agent.display_name,
      before: agent.assignment.label,
      revision: agent.assignment.revision,
      choice: { from_agent_id: agent.id },
      label: agent.assignment.label,
      instructions: agent.assignment.instructions,
    })),
  );
  const [rows, setRows] = useState<Row[]>(original);
  const [history, setHistory] = useState<Row[][]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  const update = (next: Row[]) => {
    setHistory((old) => [...old, rows]);
    setRows(next);
    setError("");
  };
  const swap = (a: string, b: string) => {
    if (!b || a === b) return;
    const first = rows.find((row) => row.id === a);
    const second = rows.find((row) => row.id === b);
    if (!first || !second) return;
    const take = (row: Row, from: Row): Row => ({
      ...row,
      choice: from.choice,
      label: from.label,
      instructions: from.instructions,
    });
    update(
      rows.map((row) =>
        row.id === a
          ? take(row, second)
          : row.id === b
            ? take(row, first)
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
      await request(`/api/rooms/${roomId}/assignments/reassign`, {
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
      className="team-dialog"
      ref={dialog}
      aria-label="Team"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>Team</h2>
      <p>
        Move a member&apos;s skills and room instructions to another member, by
        dragging or with Swap with. Room names, apps and edit permission stay
        with each member.
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
            className="team-row"
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
            <span
              className="chip"
              draggable
              onDragStart={(event) =>
                event.dataTransfer.setData("text/plain", row.id)
              }
              title="Drag to swap skills"
            >
              {row.label} ⇅
            </span>
            {row.instructions && (
              <p className="muted">Instructions: {row.instructions}</p>
            )}
            <label>
              Swap with{" "}
              <select
                value=""
                aria-label={`Swap ${row.name}'s skills with`}
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
            <button
              type="button"
              onClick={() =>
                update(
                  rows.map((item) =>
                    item.id === row.id
                      ? {
                          ...item,
                          choice: { none: true },
                          label: "No skills",
                          instructions: "",
                        }
                      : item,
                  ),
                )
              }
            >
              Remove {row.name}&apos;s skills
            </button>
          </section>
        ))}
      </div>
      <h3>Pending changes ({changed.length})</h3>
      <ul>
        {changed.map((row) => (
          <li key={row.id}>
            {row.name}: {row.before} → {row.label}
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
