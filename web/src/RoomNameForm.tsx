import { useState, type FormEvent } from "react";
import { request, type RoomAgent } from "./api";

/**
 * Lets the lead name a room member before it joins. The name is also how
 * everyone mentions it; once the agent joins the room the name is fixed.
 */
export function RoomNameForm({
  roomId,
  agent,
  archived,
  onSaved,
}: {
  roomId: number;
  agent: Pick<
    RoomAgent,
    "id" | "room_name" | "name_fixed" | "account_name" | "display_name"
  >;
  archived: boolean;
  onSaved?: () => void;
}) {
  const [draft, setDraft] = useState(agent.room_name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = agent.account_name ?? agent.display_name;
  const inputId = `room-name-${agent.id}`;

  if (agent.name_fixed || archived)
    return agent.room_name ? (
      <p className="room-name muted">
        Name in this room: <strong>@{agent.room_name}</strong>{" "}
        <span
          className="chip"
          title={
            archived
              ? "This room is archived."
              : "Names are fixed once the agent joins this room."
          }
        >
          Fixed
        </span>
      </p>
    ) : null;

  const save = async (name: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await request(
        `/api/rooms/${roomId}/members/${encodeURIComponent(agent.id)}/name`,
        name === null
          ? { method: "DELETE" }
          : { method: "PUT", body: { name } },
      );
      if (name === null) setDraft("");
      onSaved?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="room-name"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const name = draft.trim();
        void save(name ? name : null);
      }}
    >
      <label htmlFor={inputId}>Name in this room</label>{" "}
      <span className="muted">
        What everyone types after @. Fixed once {owner} joins.
      </span>
      <div className="row">
        <span aria-hidden="true">@</span>
        <input
          id={inputId}
          value={draft}
          placeholder={agent.id}
          maxLength={32}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
        />
        <button type="submit" disabled={busy}>
          Save
        </button>
        {agent.room_name && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear
          </button>
        )}
      </div>
      {error && (
        <p role="alert" id={`${inputId}-error`} className="warning-text">
          {error}
        </p>
      )}
    </form>
  );
}
