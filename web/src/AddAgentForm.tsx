import { useState, type FormEvent } from "react";
import { request, type Overview } from "./api";
import {
  AssignSkills,
  requestPins,
  reviewIds,
  type Selection,
} from "./AssignSkills";

/**
 * Adds an agent: its app (the desktop app that runs it) and, optionally, its
 * skills and room instructions in this room.
 */
export function AddAgentForm({
  overview,
  roomId,
  onAdded,
  onCancel,
}: {
  overview: Pick<Overview, "agents" | "apps" | "max_agents_per_app">;
  roomId: number;
  onAdded: () => Promise<void>;
  onCancel: () => void;
}) {
  const appCount = (appId: string) =>
    overview.agents.filter((agent) => agent.app_id === appId).length;
  const appFull = (appId: string) =>
    appCount(appId) >= overview.max_agents_per_app;
  const [newApp, setNewApp] = useState(
    () => overview.apps.find((app) => !appFull(app.id))?.id ?? "",
  );
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [addToRoom, setAddToRoom] = useState(true);
  const [selection, setSelection] = useState<Selection>({
    instructions: "",
    pins: [],
  });
  const [choosing, setChoosing] = useState(false);
  const [agentError, setAgentError] = useState("");
  const used = new Set(overview.agents.map((agent) => agent.id));
  const suggestId = (name: string) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^[^a-z]+|-+$/g, "")
        .slice(0, 60) || "agent";
    let candidate = base,
      suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  };
  const assigned =
    addToRoom && (selection.pins.length > 0 || !!selection.instructions.trim());
  const addAgent = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await request("/api/agents", {
        method: "POST",
        body: {
          id: newId,
          display_name: newName,
          app_id: newApp,
          ...(addToRoom ? { room_id: roomId } : {}),
          ...(addToRoom && roomName.trim()
            ? { room_name: roomName.trim() }
            : {}),
          ...(assigned
            ? {
                assignment: {
                  instructions: selection.instructions,
                  pins: requestPins(selection.pins),
                  review: reviewIds(selection.pins),
                  confirmed: true,
                },
              }
            : {}),
        },
      });
      await onAdded();
    } catch (error) {
      setAgentError(
        error instanceof Error ? error.message : "Something went wrong",
      );
    }
  };
  return (
    <form
      aria-label="Add agent"
      className="stack card"
      onSubmit={(event) => void addAgent(event)}
    >
      <label>
        Display name
        <input
          value={newName}
          onChange={(event) => {
            setNewName(event.target.value);
            if (!idEdited) setNewId(suggestId(event.target.value));
          }}
          required
          maxLength={100}
          placeholder="Reviewer"
        />
      </label>
      <label>
        Agent ID
        <input
          value={newId}
          onChange={(event) => {
            setNewId(event.target.value);
            setIdEdited(true);
          }}
          required
          pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
          placeholder="reviewer"
        />
        <small className="hint">
          Lowercase, hyphens allowed. Always works as an @mention.
        </small>
      </label>
      <label>
        App
        <select
          value={newApp}
          onChange={(event) => setNewApp(event.target.value)}
          required
        >
          {overview.apps.map((app) => (
            <option key={app.id} value={app.id} disabled={appFull(app.id)}>
              {app.display_name} ({appCount(app.id)}/
              {overview.max_agents_per_app})
            </option>
          ))}
        </select>
        <small className="hint">
          The desktop app that runs this agent. Agents on one app share its
          allowance.
        </small>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={addToRoom}
          onChange={(event) => setAddToRoom(event.target.checked)}
        />{" "}
        Add to this room
      </label>
      {addToRoom && (
        <label>
          Name in this room (optional)
          <input
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
            maxLength={32}
            pattern="[A-Za-z][A-Za-z0-9_\-]{0,31}"
            placeholder="A"
          />
          <small className="hint">
            What everyone types after @ in this room. Fixed once the agent
            joins.
          </small>
        </label>
      )}
      {addToRoom && (
        <section aria-label="Skills in this room">
          <strong>Skills in this room</strong>
          {selection.pins.length === 0 ? (
            <p className="muted">
              No skills yet. You can add them later with Assign skills.
            </p>
          ) : (
            <ol>
              {selection.pins.map((pin) => (
                <li key={`${pin.kind}:${pin.name}`}>
                  {pin.name} ·{" "}
                  {pin.delivery === "full" ? "full text" : "summary"}
                </li>
              ))}
            </ol>
          )}
          {selection.instructions.trim() && (
            <p className="muted">Instructions: {selection.instructions}</p>
          )}
          <button type="button" onClick={() => setChoosing(true)}>
            Choose skills…
          </button>
        </section>
      )}
      {choosing && (
        <AssignSkills
          roomId={roomId}
          agentName={newName.trim() || "new agent"}
          initial={selection}
          onChoose={setSelection}
          onClose={() => setChoosing(false)}
        />
      )}
      {agentError && (
        <p role="alert" className="warning-text">
          {agentError}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={!newApp}>
          Add agent
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted">
        Next: use the new card&apos;s Copy join prompt in a new conversation in
        that app.
      </p>
    </form>
  );
}
