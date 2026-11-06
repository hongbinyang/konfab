import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Markdown from "react-markdown";
import {
  request,
  UnauthorizedError,
  type AgentState,
  type Overview,
  type RoomAgent,
  type RoomState,
} from "./api";

const STATE_LABELS: Record<AgentState, string> = {
  not_joined: "Not joined",
  waiting: "Waiting",
  working: "Working",
  outside_hours: "Outside hours",
  not_responding: "Not responding",
};

const REPORT_LABELS = {
  low_allowance: "Low on allowance",
  out_of_allowance: "Out of allowance",
  other: "Status",
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

const CLOSING_SOON_MS = 15 * 60_000;
const EXTEND_OFFER_MS = 60 * 60_000;

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

export function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const refresh = useCallback(async () => {
    try {
      const next = await request<Overview>("/api/overview");
      setOverview(next);
      const id = selectedRef.current;
      const openRooms = next.rooms.filter((item) => !item.archived);
      const current = next.rooms.find((item) => item.id === id);
      const target = current ? current.id : (openRooms[0]?.id ?? null);
      if (target !== id) setSelectedId(target);
      setRoom(
        target === null
          ? null
          : await request<RoomState>(`/api/rooms/${target}`),
      );
      setSignedOut(false);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) setSignedOut(true);
      else setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, selectedId]);

  useEffect(() => {
    if (signedOut) return;
    const events = new EventSource("/api/events");
    events.onmessage = () => void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [refresh, signedOut]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        setError("");
        await action();
        await refresh();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [refresh],
  );

  if (signedOut) {
    return (
      <main className="signin">
        <h1>Konfab</h1>
        <p>Sign in with a link from the computer running Konfab:</p>
        <pre>npm run login-link</pre>
        <p>Open the link it prints. Each link works once.</p>
      </main>
    );
  }
  if (!overview) return <main className="signin">Loading…</main>;

  return (
    <div className="layout">
      <Sidebar
        overview={overview}
        selectedId={selectedId}
        onSelect={setSelectedId}
        act={act}
      />
      <main className="chat">
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        {overview.paused_all && (
          <p className="banner">
            All rooms are paused. No new turns will start.
          </p>
        )}
        {overview.reports.map((report) => (
          <div className="banner warning" key={report.id}>
            <span>
              <strong>
                {report.agent_id} in #{report.room}:{" "}
                {REPORT_LABELS[report.kind]}.
              </strong>{" "}
              {report.detail}
            </span>
            <button
              type="button"
              className="quiet"
              onClick={() =>
                void act(() =>
                  request(`/api/reports/${report.id}/dismiss`, {
                    method: "POST",
                  }),
                )
              }
            >
              Dismiss
            </button>
          </div>
        ))}
        {room ? (
          <Room key={room.room.id} state={room} act={act} />
        ) : (
          <div className="empty">
            <h2>No rooms yet</h2>
            <p>Create a room to give your agents a topic to discuss.</p>
          </div>
        )}
      </main>
      <Panel overview={overview} room={room} act={act} />
    </div>
  );
}

type Act = (action: () => Promise<unknown>) => Promise<void>;

function Sidebar({
  overview,
  selectedId,
  onSelect,
  act,
}: {
  overview: Overview;
  selectedId: number | null;
  onSelect: (id: number) => void;
  act: Act;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const created = await request<{ id: number }>("/api/rooms", {
        method: "POST",
        body: {
          name: name.trim(),
          topic: topic.trim(),
          members: overview.agents.map((agent) => agent.id),
        },
      });
      setName("");
      setTopic("");
      onSelect(created.id);
    });
  };

  const openRooms = overview.rooms.filter((room) => !room.archived);
  const archived = overview.rooms.filter((room) => room.archived);
  const roomButton = (room: Overview["rooms"][number]) => (
    <li key={room.id}>
      <button
        type="button"
        className={room.id === selectedId ? "room selected" : "room"}
        aria-current={room.id === selectedId ? "true" : undefined}
        onClick={() => onSelect(room.id)}
      >
        # {room.name}
        {room.paused && <span className="tag">Paused</span>}
      </button>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Rooms">
      <h1>Konfab</h1>
      <ul>{openRooms.map(roomButton)}</ul>
      <form className="stack" onSubmit={create}>
        <h2>New room</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="design-review"
            required
          />
        </label>
        <label>
          Topic
          <textarea
            value={topic}
            rows={2}
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        <button type="submit">Create room</button>
      </form>
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void act(() =>
            request("/api/pause-all", {
              method: "POST",
              body: { paused: !overview.paused_all },
            }),
          )
        }
      >
        {overview.paused_all ? "Resume all rooms" : "Pause all rooms"}
      </button>
      {archived.length > 0 && (
        <details>
          <summary>Archived ({archived.length})</summary>
          <ul>{archived.map(roomButton)}</ul>
        </details>
      )}
    </nav>
  );
}

function Room({ state, act }: { state: RoomState; act: Act }) {
  const { room, messages, agents } = state;
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic);
  const listRef = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const lastMessageId = messages.at(-1)?.id;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RoomState["messages"] | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [lastMessageId]);

  const send = () => {
    if (!body.trim()) return;
    void act(async () => {
      await request(`/api/rooms/${room.id}/messages`, {
        method: "POST",
        body: { body },
      });
      setBody("");
      atBottom.current = true;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await request(`/api/rooms/${room.id}`, {
        method: "PATCH",
        body: { name: name.trim(), topic },
      });
      setEditing(false);
    });
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      setResults(null);
      return;
    }
    void act(async () => {
      const found = await request<{ messages: RoomState["messages"] }>(
        `/api/rooms/${room.id}/search?q=${encodeURIComponent(query)}`,
      );
      setResults(found.messages);
    });
  };

  const displayName = (id: string) =>
    agents.find((agent) => agent.id === id)?.display_name ?? id;
  const limited = room.agent_streak >= room.streak_limit;

  return (
    <>
      <header className="room-header">
        {editing ? (
          <form className="stack" onSubmit={save}>
            <label>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              Topic
              <textarea
                value={topic}
                rows={3}
                onChange={(event) => setTopic(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="submit">Save</button>
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="room-title">
              <h2># {room.name}</h2>
              <p>{room.topic || "No topic yet"}</p>
            </div>
            {!room.archived && (
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setName(room.name);
                    setTopic(room.topic);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void act(() =>
                      request(`/api/rooms/${room.id}/pause`, {
                        method: "POST",
                        body: { paused: !room.paused },
                      }),
                    )
                  }
                >
                  {room.paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (window.confirm(`Archive #${room.name}?`)) {
                      void act(() =>
                        request(`/api/rooms/${room.id}/archive`, {
                          method: "POST",
                        }),
                      );
                    }
                  }}
                >
                  Archive
                </button>
              </div>
            )}
          </>
        )}
      </header>

      <form className="search" role="search" onSubmit={search}>
        <label htmlFor="search">Search messages</label>
        <input
          id="search"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setResults(null);
          }}
        />
        <button type="submit" className="secondary">
          Search
        </button>
        <a
          className="button secondary"
          href={`/api/rooms/${room.id}/export`}
          download
        >
          Export
        </a>
      </form>
      {results && (
        <section className="results" aria-label="Search results">
          <p className="muted">
            {results.length === 0
              ? "No matching messages"
              : `${results.length} matching ${results.length === 1 ? "message" : "messages"}`}
          </p>
          <ul>
            {results.map((message) => (
              <li key={message.id}>
                <span className="sender">
                  {message.sender_type === "user"
                    ? "You"
                    : displayName(message.sender_id)}
                </span>
                <span className="time">{formatTime(message.created_at)}</span>
                <div className="body">
                  <Markdown>{message.body}</Markdown>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ol
        className="messages"
        ref={listRef}
        aria-live="polite"
        onScroll={(event) => {
          const list = event.currentTarget;
          atBottom.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        }}
      >
        {messages.length === 0 && (
          <li className="hint">
            No messages yet. Post one to give each agent a turn, or use
            @mentions to choose who responds.
          </li>
        )}
        {messages.map((message) => (
          <li key={message.id}>
            <span className="sender">
              {message.sender_type === "user"
                ? "You"
                : displayName(message.sender_id)}
            </span>
            <span className="time">{formatTime(message.created_at)}</span>
            <div className="body">
              <Markdown>{message.body}</Markdown>
            </div>
          </li>
        ))}
      </ol>

      {limited && (
        <p className="banner">
          Agents have posted {room.agent_streak} messages in a row. Post a
          message to continue.
        </p>
      )}
      {room.archived ? (
        <p className="banner">This room is archived and is read-only.</p>
      ) : (
        <div className="composer">
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message the room, or use ${[
              ...agents.map((agent) => `@${agent.id}`),
              "@all",
            ].join(", ")}`}
          />
          <button type="button" onClick={send}>
            Send
          </button>
        </div>
      )}
    </>
  );
}

function Panel({
  overview,
  room,
  act,
}: {
  overview: Overview;
  room: RoomState | null;
  act: Act;
}) {
  return (
    <aside className="panel">
      {overview.permissions.length > 0 && (
        <section aria-label="Permission requests">
          <h2>Permission requests</h2>
          {overview.permissions.map((permission) => (
            <div className="card attention" key={permission.id}>
              <p>
                <strong>{permission.agent_id}</strong> in #{permission.room}{" "}
                wants to send data to <strong>{permission.recipient}</strong>
              </p>
              <dl>
                <dt>Data</dt>
                <dd>{permission.data_description}</dd>
                <dt>Reason</dt>
                <dd>{permission.reason}</dd>
              </dl>
              <div className="row">
                {(["approved", "denied"] as const).map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    className={decision === "denied" ? "secondary" : undefined}
                    onClick={() =>
                      void act(() =>
                        request(`/api/permissions/${permission.id}/decision`, {
                          method: "POST",
                          body: { decision },
                        }),
                      )
                    }
                  >
                    {decision === "approved" ? "Approve" : "Deny"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      {room && <Agents overview={overview} room={room} act={act} />}
    </aside>
  );
}

function Agents({
  overview,
  room,
  act,
}: {
  overview: Overview;
  room: RoomState;
  act: Act;
}) {
  const members = room.agents.map((agent) => agent.id);
  const setMembers = (next: string[]) =>
    void act(() =>
      request(`/api/rooms/${room.room.id}/members`, {
        method: "PUT",
        body: { members: next },
      }),
    );

  return (
    <section aria-label="Agents">
      <h2>Agents</h2>
      {overview.agents.map((agent) => {
        const member = room.agents.find((item) => item.id === agent.id);
        return (
          <div className="card" key={agent.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={member !== undefined}
                disabled={room.room.archived}
                onChange={(event) =>
                  setMembers(
                    event.target.checked
                      ? [...members, agent.id]
                      : members.filter((id) => id !== agent.id),
                  )
                }
              />
              <strong>{agent.display_name}</strong>
            </label>
            {member ? (
              <AgentDetails
                agent={member}
                archived={room.room.archived}
                act={act}
              />
            ) : (
              <p className="muted">Not in this room</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function AgentDetails({
  agent,
  archived,
  act,
}: {
  agent: RoomAgent;
  archived: boolean;
  act: Act;
}) {
  const [copied, setCopied] = useState(false);
  const { stats } = agent;

  return (
    <>
      <p className={`state ${agent.state}`}>{STATE_LABELS[agent.state]}</p>
      {agent.state === "not_responding" && (
        <p className="warning-text">
          It may be out of allowance, so check its app.
        </p>
      )}
      {agent.hours && (
        <p className="muted">
          Hours:{" "}
          {agent.hours.start === agent.hours.end
            ? "All day"
            : `${agent.hours.start} to ${agent.hours.end}`}
          {agent.state === "outside_hours" && agent.next_start
            ? `. Next opens ${new Date(agent.next_start).toLocaleString([], {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}`
            : ""}
        </p>
      )}
      {agent.closes_at !== null && (
        <p
          className={
            agent.closes_at - Date.now() <= CLOSING_SOON_MS
              ? "warning-text"
              : "muted"
          }
        >
          Closes at {formatTime(agent.closes_at)}
        </p>
      )}
      {!archived &&
        (agent.state === "outside_hours" ||
          (agent.closes_at !== null &&
            agent.closes_at - Date.now() <= EXTEND_OFFER_MS)) && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void act(() =>
                request(`/api/agents/${agent.id}/extend-hours`, {
                  method: "POST",
                  body: { minutes: 60 },
                }),
              )
            }
          >
            Open for 1 hour
          </button>
        )}
      {!archived && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(agent.join_prompt).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy join prompt"}
        </button>
      )}
      <details>
        <summary>Activity</summary>
        <dl>
          <dt>Wait calls</dt>
          <dd>{stats.model_wait_calls}</dd>
          <dt>Calls per hour</dt>
          <dd>{stats.calls_per_hour?.toFixed(1) ?? "None"}</dd>
          <dt>Longest gap</dt>
          <dd>{formatDuration(stats.longest_gap_ms)}</dd>
          <dt>Rejoins</dt>
          <dd>{stats.rejoins}</dd>
          <dt>Turns completed</dt>
          <dd>{stats.turns_completed}</dd>
          <dt>Turns skipped</dt>
          <dd>{stats.turns_skipped}</dd>
        </dl>
      </details>
    </>
  );
}
