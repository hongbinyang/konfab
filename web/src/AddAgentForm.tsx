import { useEffect, useRef, useState, type FormEvent } from "react";
import { request, type Overview } from "./api";

export type RolePreview = {
  id: string;
  revision_id: string;
  number: number;
  title: string;
  role_md: string;
  skills: Array<{ name: string; reviewed: number }>;
};

export type RoleOption = {
  id: string;
  revision_id: string;
  name: string;
  title: string;
};

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
  const [idEdited, setIdEdited] = useState(false);
  const [newRole, setNewRole] = useState("");
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [rolePreview, setRolePreview] = useState<RolePreview | null>(null);
  const [confirmedRevision, setConfirmedRevision] = useState("");
  const previewRequest = useRef(0);
  const [addToRoom, setAddToRoom] = useState(true);
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
  useEffect(() => {
    request<{ roles: RoleOption[] }>("/api/roles")
      .then((result) => setRoles(result.roles))
      .catch(() => setRoles([]));
  }, []);
  const pickRole = (id: string) => {
    const requestId = ++previewRequest.current;
    setNewRole(id);
    setRolePreview(null);
    setConfirmedRevision("");
    if (id)
      request<RolePreview>(`/api/roles/${encodeURIComponent(id)}`)
        .then((detail) => {
          if (requestId !== previewRequest.current) return;
          setRolePreview(detail);
          setConfirmedRevision("");
        })
        .catch((error) => {
          if (requestId === previewRequest.current)
            setAgentError(errorMessage(error));
        });
  };
  const roleUnreviewed =
    rolePreview?.skills.filter((skill) => !skill.reviewed) ?? [];
  const roleReady =
    !addToRoom ||
    !newRole ||
    (rolePreview?.id === newRole &&
      roleUnreviewed.length === 0 &&
      confirmedRevision === rolePreview.revision_id);
  const addAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!roleReady) return;
    const role = addToRoom && newRole ? rolePreview : null;
    try {
      await request("/api/agents", {
        method: "POST",
        body: {
          id: newId,
          display_name: newName,
          app_id: newApp,
          ...(addToRoom ? { room_id: roomId } : {}),
          ...(role
            ? {
                role: {
                  role_id: role.id,
                  role_revision_id: role.revision_id,
                  confirmed: true,
                },
              }
            : {}),
        },
      });
      await onAdded();
    } catch (error) {
      setAgentError(errorMessage(error));
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
          Used for @mentions. Lowercase, hyphens allowed.
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
          Role in this room
          <select
            value={newRole}
            onChange={(event) => pickRole(event.target.value)}
          >
            <option value="">No role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.title || role.name}
              </option>
            ))}
          </select>
          <small className="hint">
            Roles are per room. Change it later with Change role.
          </small>
        </label>
      )}
      {addToRoom && newRole && (
        <section className="role-preview">
          {rolePreview?.id !== newRole ? (
            <p className="muted">Loading role preview…</p>
          ) : (
            <>
              <h4>
                Preview: {rolePreview.title} · rev {rolePreview.number}
              </h4>
              <pre>{rolePreview.role_md}</pre>
              <p className="muted">
                Skills:{" "}
                {rolePreview.skills.length === 0
                  ? "none"
                  : rolePreview.skills
                      .map(
                        (skill) =>
                          `${skill.name} (${skill.reviewed ? "reviewed" : "not reviewed"})`,
                      )
                      .join(", ")}
              </p>
              {roleUnreviewed.length > 0 ? (
                <p className="warning-text">
                  Review {roleUnreviewed.map((skill) => skill.name).join(", ")}{" "}
                  in Manage library before assigning this role, or add the agent
                  with no role.
                </p>
              ) : (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmedRevision === rolePreview.revision_id}
                    onChange={(event) =>
                      setConfirmedRevision(
                        event.target.checked ? rolePreview.revision_id : "",
                      )
                    }
                  />{" "}
                  I reviewed this role (rev {rolePreview.number}) and want to
                  assign it
                </label>
              )}
            </>
          )}
        </section>
      )}
      {agentError && (
        <p role="alert" className="warning-text">
          {agentError}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={!newApp || !roleReady}>
          Add agent
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="muted">
        Next: use the new card's Copy join prompt in a new conversation in that
        app.
      </p>
    </form>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
