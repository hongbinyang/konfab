import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Markdown from "react-markdown";
import { EmojiPicker } from "./EmojiPicker";
import {
  request,
  uploadAttachment,
  UnauthorizedError,
  type ActivityEvent,
  type Attachment,
  type Decision,
  type Permission,
  type AgentState,
  type Overview,
  type RoomAgent,
  type RoomState,
} from "./api";

const STATE_LABELS: Record<AgentState, string> = {
  not_joined: "Not joined",
  waiting: "Idle",
  working: "Working",
  queued: "Queued",
  waiting_approval: "Waiting for approval",
  window_ended: "Run window ended",
  on_break: "On break",
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

const BREAK_CONFIRMATION =
  "Agents will stop and use no more allowance. To bring one back, paste its join prompt into its app. Start the break?";
const BREAK_HELP =
  "Agents stop and use no allowance until you paste their join prompts";
const ROLE_PRESETS: Record<string, string> = {
  Implementer:
    "Implement the agreed changes. Keep changes small, run the tests, and report what you changed.",
  Reviewer:
    "Review proposals and code for bugs, risks, and missing tests. Be specific, and say how confident you are.",
  Critic:
    "Challenge assumptions and point out weaknesses or better alternatives. Be constructive and concise.",
  Researcher:
    "Gather facts and sources, separate evidence from opinion, and summarize what you find.",
};
const CLOSING_SOON_MS = 15 * 60_000;

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
  const [pageConnected, setPageConnected] = useState(false);
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
    events.onopen = () => setPageConnected(true);
    events.onerror = () => setPageConnected(false);
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
          <Room
            key={room.room.id}
            state={room}
            act={act}
            pageConnected={pageConnected}
          />
        ) : (
          <div className="empty">
            <h2>No rooms yet</h2>
            <p>Create a room to give your agents a topic to discuss.</p>
          </div>
        )}
      </main>
      <Panel
        overview={overview}
        room={room}
        act={act}
        pageConnected={pageConnected}
      />
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
        {room.on_break ? (
          <span className="tag">On break</span>
        ) : (
          room.paused && <span className="tag">Paused</span>
        )}
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
      <button
        type="button"
        className="secondary"
        title={BREAK_HELP}
        onClick={() => {
          if (window.confirm(BREAK_CONFIRMATION)) {
            void act(() => request("/api/break-all", { method: "POST" }));
          }
        }}
      >
        Break for all rooms
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

function Room({
  state,
  act,
  pageConnected,
}: {
  state: RoomState;
  act: Act;
  pageConnected: boolean;
}) {
  const { room, messages, agents } = state;
  const passes = state.passes ?? [];
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic);
  const [brief, setBrief] = useState(room.brief);
  const listRef = useRef<HTMLOListElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const atBottom = useRef(true);
  const timelineKey = `${messages.at(-1)?.id}-${passes.at(-1)?.id}-${state.permissions.at(-1)?.id}`;
  // On a time tie, a message comes first, because a pass follows what it answers.
  const timeline = [
    ...messages.map((message) => ({ kind: "message" as const, ...message })),
    ...passes.map((pass) => ({ kind: "pass" as const, ...pass })),
    ...state.permissions.map((permission) => ({
      kind: "permission" as const,
      ...permission,
    })),
  ].sort((a, b) => a.created_at - b.created_at);
  const [olderActivity, setOlderActivity] = useState<ActivityEvent[]>([]);
  const [hasOlderActivity, setHasOlderActivity] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RoomState["messages"] | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [timelineKey]);

  const addFiles = async (files: File[]) => {
    if (!files.length || uploading) return;
    if (attachments.length + files.length > 20) {
      setAttachmentError("Choose up to 20 files per message.");
      return;
    }
    setUploading(true);
    setAttachmentError("");
    try {
      for (const file of files) {
        const uploaded = await uploadAttachment(room.id, file);
        setAttachments((current) => [...current, uploaded]);
      }
    } catch (error) {
      setAttachmentError(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };
  const removeAttachment = (attachment: Attachment) => {
    void act(async () => {
      await request(`/api/rooms/${room.id}/attachments/${attachment.id}`, {
        method: "DELETE",
      });
      setAttachments((current) =>
        current.filter((item) => item.id !== attachment.id),
      );
    });
  };

  const send = () => {
    if (uploading || (!body.trim() && !attachments.length)) return;
    void act(async () => {
      await request(`/api/rooms/${room.id}/messages`, {
        method: "POST",
        body: { body, attachment_ids: attachments.map((item) => item.id) },
      });
      setBody("");
      setAttachments([]);
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
        body: { name: name.trim(), topic, brief },
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
            <label>
              Brief for agents
              <textarea
                value={brief}
                rows={5}
                placeholder="Goals, constraints, and how the agents should work together"
                onChange={(event) => setBrief(event.target.value)}
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
              <ul
                className="participant-statuses"
                aria-label="Participant status"
              >
                <li title="This status reflects the page connection, not whether a person is present.">
                  Lead: {pageConnected ? "Page connected" : "Page disconnected"}
                </li>
                {agents.map((agent) => (
                  <li key={agent.id}>
                    {agent.display_name}: {STATE_LABELS[agent.state]}
                  </li>
                ))}
              </ul>
              {room.brief && (
                <details>
                  <summary>Brief for agents</summary>
                  <p className="brief">{room.brief}</p>
                </details>
              )}
            </div>
            {!room.archived && (
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setName(room.name);
                    setTopic(room.topic);
                    setBrief(room.brief);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary"
                  title="Stops new turns. Waiting agents still use allowance."
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
                {!room.on_break && (
                  <button
                    type="button"
                    className="secondary"
                    title={BREAK_HELP}
                    onClick={() => {
                      if (window.confirm(BREAK_CONFIRMATION)) {
                        void act(() =>
                          request(`/api/rooms/${room.id}/break`, {
                            method: "POST",
                          }),
                        );
                      }
                    }}
                  >
                    Take a break
                  </button>
                )}
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
                    ? "You (Lead)"
                    : displayName(message.sender_id)}
                </span>
                <span className="time">{formatTime(message.created_at)}</span>
                <div className="body">
                  <Markdown>{message.body}</Markdown>
                </div>
                <MessageAttachments
                  roomId={room.id}
                  attachments={message.attachments ?? []}
                />
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
        {messages.length === 0 && state.permissions.length === 0 && (
          <li className="hint">
            No messages yet. Post one to give each agent a turn, or use
            @mentions to choose who responds.
          </li>
        )}
        {timeline.map((item) =>
          item.kind === "pass" ? (
            <li key={`pass-${item.id}`} className="pass">
              {displayName(item.agent_id)} passed
              {item.reason ? `: ${item.reason}` : ""}
              <span className="time">{formatTime(item.created_at)}</span>
            </li>
          ) : item.kind === "permission" ? (
            <li key={`permission-${item.id}`} className="permission-card">
              <PermissionCard
                item={item}
                name={displayName(item.agent_id)}
                act={act}
              />
            </li>
          ) : (
            <li
              id={`message-${item.id}`}
              key={`message-${item.id}`}
              className={
                item.mentions?.some(
                  (mention) => mention === "lead" || mention === "all",
                )
                  ? "mentions-lead"
                  : undefined
              }
            >
              <span className="sender">
                {item.sender_type === "user"
                  ? "You (Lead)"
                  : displayName(item.sender_id)}
              </span>
              <span className="time">{formatTime(item.created_at)}</span>
              <div className="body">
                <Markdown>{item.body}</Markdown>
              </div>
              <MessageAttachments
                roomId={room.id}
                attachments={item.attachments ?? []}
              />
              {!room.archived && (
                <button
                  type="button"
                  className="quiet"
                  disabled={
                    item.body.trim().length === 0 ||
                    item.body.trim().length > 2000
                  }
                  onClick={() =>
                    void act(() =>
                      request(`/api/rooms/${room.id}/decisions`, {
                        method: "POST",
                        body: { body: item.body, source_message_id: item.id },
                      }),
                    )
                  }
                >
                  Mark as decision
                </button>
              )}
            </li>
          ),
        )}
      </ol>

      <PermissionLog
        roomId={room.id}
        recent={state.permissions}
        agents={agents}
        act={act}
      />

      <details className="activity">
        <summary>Activity timeline</summary>
        <ol>
          {[
            ...new Map(
              [...state.activity, ...olderActivity].map((event) => [
                event.id,
                event,
              ]),
            ).values(),
          ]
            .sort((a, b) => b.id - a.id)
            .map((event) => (
              <li key={event.id}>
                <time dateTime={new Date(event.created_at).toISOString()}>
                  {new Date(event.created_at).toLocaleString()}
                </time>{" "}
                {event.agent_id ? displayName(event.agent_id) : "Room"}:{" "}
                {event.type === "contact_lost"
                  ? `Contact lost (inferred) — last seen ${event.last_contact_at === null ? "unknown" : new Date(event.last_contact_at).toLocaleString()}`
                  : event.type.replaceAll("_", " ")}
              </li>
            ))}
        </ol>
        {hasOlderActivity &&
          (state.activity.length === 200 || olderActivity.length > 0) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const ids = [...state.activity, ...olderActivity].map(
                  (event) => event.id,
                );
                void act(async () => {
                  const page = await request<{ events: ActivityEvent[] }>(
                    `/api/rooms/${room.id}/activity?before_id=${Math.min(...ids)}`,
                  );
                  setOlderActivity((current) => [...current, ...page.events]);
                  setHasOlderActivity(page.events.length === 200);
                });
              }}
            >
              Load older activity
            </button>
          )}
      </details>

      {room.on_break && (
        <p className="banner">
          Agents in this room are on break and aren&apos;t using allowance.
          Messages you post will wait for them. To bring an agent back, copy its
          join prompt and paste it into its app.
        </p>
      )}
      {limited && (
        <p className="banner">
          Agents have posted {room.agent_streak} messages in a row. Post a
          message to continue.
        </p>
      )}
      {room.archived ? (
        <p className="banner">This room is archived and is read-only.</p>
      ) : (
        <div
          className="composer"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <label htmlFor="message">Message</label>
          {attachmentError && (
            <p className="attachment-error" role="alert">
              {attachmentError}
            </p>
          )}
          {(attachments.length > 0 || uploading) && (
            <div className="attachment-drafts">
              {attachments.map((item) => (
                <span className="attachment-chip" key={item.id}>
                  {item.media_type.startsWith("image/") && (
                    <img
                      src={`/api/rooms/${room.id}/attachments/${item.id}?inline=1`}
                      alt=""
                    />
                  )}{" "}
                  {item.filename}{" "}
                  <button
                    type="button"
                    aria-label={`Remove ${item.filename}`}
                    onClick={() => removeAttachment(item)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {uploading && <span>Uploading…</span>}
            </div>
          )}
          <textarea
            id="message"
            ref={messageRef}
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter(
                  (item) =>
                    item.kind === "file" && item.type.startsWith("image/"),
                )
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={`Message the room, or use ${[
              ...agents.map((agent) => `@${agent.id}`),
              "@lead",
              "@all",
            ].join(", ")}`}
          />
          <EmojiPicker textarea={messageRef} onInsert={setBody} />
          <input
            type="file"
            ref={fileRef}
            className="visually-hidden"
            multiple
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <button type="button" onClick={send} disabled={uploading}>
            Send
          </button>
        </div>
      )}
    </>
  );
}

function PermissionCard({
  item,
  name,
  act,
}: {
  item: Permission;
  name: string;
  act: Act;
}) {
  return (
    <>
      <strong>Permission request from {name}</strong>
      <span className="time">{new Date(item.created_at).toLocaleString()}</span>
      <p>
        Recipient: {item.recipient}
        <br />
        Data: {item.data_description}
        <br />
        Reason: {item.reason}
      </p>
      {item.data_type === "code_push" &&
        (item.push_repository ? (
          <p>
            Repository: {item.push_repository}
            <br />
            Branch: {item.push_branch}
            <br />
            Commits:{" "}
            <code>
              {item.push_base}..{item.push_head}
            </code>
          </p>
        ) : (
          <p>Legacy request: no recorded commit scope.</p>
        ))}
      {item.state === "pending" ? (
        <div className="row">
          {(["approved", "denied"] as const).map((decision) => (
            <button
              key={decision}
              type="button"
              className={decision === "denied" ? "secondary" : undefined}
              onClick={() =>
                void act(() =>
                  request(`/api/permissions/${item.id}/decision`, {
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
      ) : (
        <p>
          {item.state === "approved" ? "Approved" : "Denied"}{" "}
          {item.decided_by === "pre_approval"
            ? "automatically (pre-approval)"
            : "by you"}
          {item.decided_at !== null
            ? ` at ${new Date(item.decided_at).toLocaleString()}`
            : ""}
        </p>
      )}
    </>
  );
}

function PermissionLog({
  roomId,
  recent,
  agents,
  act,
}: {
  roomId: number;
  recent: Permission[];
  agents: RoomAgent[];
  act: Act;
}) {
  const [open, setOpen] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [items, setItems] = useState<Permission[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = recent
    .map((item) => `${item.id}:${item.state}:${item.decided_at ?? ""}`)
    .join(",");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        let cursor: number | null = null;
        const all: Permission[] = [];
        for (let page = 0; page < pageCount; page += 1) {
          const url: string = `/api/rooms/${roomId}/permissions${cursor === null ? "" : `?before_id=${cursor}`}`;
          const result: {
            permissions: Permission[];
            next_before_id: number | null;
          } = await request(url);
          all.push(...result.permissions);
          cursor = result.next_before_id;
          if (cursor === null) break;
        }
        if (!cancelled) {
          setItems(all);
          setHasOlder(cursor !== null);
          setError("");
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, pageCount, revision, roomId]);
  const pending = recent
    .filter((item) => item.state === "pending")
    .sort((a, b) => b.id - a.id);
  const answered = items.filter((item) => item.state !== "pending");
  return (
    <details
      className="permission-log"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Permissions</summary>
      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading…</p>}
      {!loading && !pending.length && !answered.length && (
        <p>No permission requests yet.</p>
      )}
      <ol>
        {[...pending, ...answered].map((item) => (
          <li className="permission-card" key={item.id}>
            <PermissionCard
              item={item}
              name={
                agents.find((agent) => agent.id === item.agent_id)
                  ?.display_name ?? item.agent_id
              }
              act={act}
            />
          </li>
        ))}
      </ol>
      {hasOlder && (
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => setPageCount((count) => count + 1)}
        >
          Load older
        </button>
      )}
    </details>
  );
}

function MessageAttachments({
  roomId,
  attachments,
}: {
  roomId: number;
  attachments: Attachment[];
}) {
  if (!attachments.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((item) => {
        const url = `/api/rooms/${roomId}/attachments/${item.id}`;
        return (
          <div key={item.id}>
            {item.media_type.startsWith("image/") && (
              <a href={url} download={item.filename}>
                <img src={`${url}?inline=1`} alt={item.filename} />
              </a>
            )}
            <a href={url} download={item.filename}>
              {item.filename}
            </a>{" "}
            <span className="muted">({Math.ceil(item.size / 1024)} KB)</span>
          </div>
        );
      })}
    </div>
  );
}

function Panel({
  overview,
  room,
  act,
  pageConnected,
}: {
  overview: Overview;
  room: RoomState | null;
  act: Act;
  pageConnected: boolean;
}) {
  return (
    <aside className="panel">
      <section aria-label="Lead status">
        <h2>Lead</h2>
        <p title="This status reflects the page connection, not whether a person is present.">
          {pageConnected ? "Page connected" : "Page disconnected"}
        </p>
      </section>
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
                {permission.data_type === "code_push" &&
                  permission.push_repository && (
                    <>
                      <dt>Repository</dt>
                      <dd>{permission.push_repository}</dd>
                      <dt>Branch</dt>
                      <dd>{permission.push_branch}</dd>
                      <dt>Commits</dt>
                      <dd>
                        <code>
                          {permission.push_base}..{permission.push_head}
                        </code>
                      </dd>
                    </>
                  )}
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
      {room && <Decisions key={room.room.id} room={room} act={act} />}
      {room && <Agents overview={overview} room={room} act={act} />}
    </aside>
  );
}

function Decisions({ room, act }: { room: RoomState; act: Act }) {
  const [body, setBody] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    void act(async () => {
      await request(`/api/rooms/${room.room.id}/decisions`, {
        method: "POST",
        body: { body },
      });
      setBody("");
    });
  };
  return (
    <section aria-label="Decisions">
      <h2>Decisions</h2>
      {!room.room.archived && (
        <form className="stack" onSubmit={submit}>
          <label>
            New decision
            <textarea
              rows={2}
              maxLength={2000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!body.trim()}>
            Add decision
          </button>
        </form>
      )}
      {room.decisions.length === 0 && <p className="muted">No decisions yet</p>}
      {room.decisions.map((decision) => (
        <DecisionCard
          key={decision.id}
          decision={decision}
          roomId={room.room.id}
          archived={room.room.archived}
          act={act}
        />
      ))}
    </section>
  );
}

function DecisionCard({
  decision,
  roomId,
  archived,
  act,
}: {
  decision: Decision;
  roomId: number;
  archived: boolean;
  act: Act;
}) {
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState(decision.body);
  const [versions, setVersions] = useState<
    { version: number; body: string; created_at: number }[] | null
  >(null);
  const path = `/api/rooms/${roomId}/decisions/${decision.id}`;
  const change = (
    action: "confirm" | "reject" | "revise" | "retire",
    body?: string,
  ) =>
    void act(async () => {
      await request(path, {
        method: "POST",
        body: { action, ...(body ? { body } : {}) },
      });
      setRevising(false);
      setVersions(null);
    });
  return (
    <div className="card decision-card">
      <p>
        <strong>
          {decision.status === "confirmed"
            ? "Confirmed"
            : decision.status === "proposed"
              ? `Proposed by ${decision.proposer}`
              : decision.status === "rejected"
                ? "Rejected"
                : "Retired"}
        </strong>{" "}
        · v{decision.version}
      </p>
      <p>{decision.body}</p>
      {decision.source_message_id !== null && (
        <a href={`#message-${decision.source_message_id}`}>Source message</a>
      )}
      {!archived && decision.status === "proposed" && (
        <div className="row">
          <button type="button" onClick={() => change("confirm")}>
            Confirm
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => change("reject")}
          >
            Reject
          </button>
        </div>
      )}
      {!archived &&
        decision.status === "confirmed" &&
        (revising ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              change("revise", draft);
            }}
          >
            <label>
              Revised decision
              <textarea
                value={draft}
                maxLength={2000}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <div className="row">
              <button type="submit" disabled={!draft.trim()}>
                Save
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setRevising(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft(decision.body);
                setRevising(true);
              }}
            >
              Revise
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => change("retire")}
            >
              Retire
            </button>
          </div>
        ))}
      {decision.version > 1 && (
        <details
          onToggle={(event) => {
            if (event.currentTarget.open && !versions)
              void act(async () => {
                const result = await request<{
                  versions: {
                    version: number;
                    body: string;
                    created_at: number;
                  }[];
                }>(`${path}/versions`);
                setVersions(result.versions);
              });
          }}
        >
          <summary>Version history</summary>
          <ol>
            {versions?.map((version) => (
              <li key={version.version}>
                v{version.version}
                {version.version !== decision.version
                  ? " (superseded)"
                  : " (current)"}
                : {version.body}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
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
                roomId={room.room.id}
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
  roomId,
  archived,
  act,
}: {
  agent: RoomAgent;
  roomId: number;
  archived: boolean;
  act: Act;
}) {
  const [copied, setCopied] = useState(false);
  const { stats } = agent;
  const [editingRole, setEditingRole] = useState(false);
  const [role, setRole] = useState(agent.role);
  const [canEdit, setCanEdit] = useState(agent.can_edit);

  const saveRole = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await request(`/api/rooms/${roomId}/members/${agent.id}`, {
        method: "PUT",
        body: { role, can_edit: canEdit },
      });
      setEditingRole(false);
    });
  };

  return (
    <>
      <p className={`state ${agent.state}`}>{STATE_LABELS[agent.state]}</p>
      <p className="muted">
        Connected since:{" "}
        {stats.session_started_at === null
          ? "—"
          : new Date(stats.session_started_at).toLocaleString()}
        <br />
        Last contact:{" "}
        {stats.last_contact_at === null
          ? "—"
          : new Date(stats.last_contact_at).toLocaleString()}
        <br />
        Longest completed observed wait:{" "}
        {stats.longest_wait_ms === null
          ? "—"
          : formatDuration(stats.longest_wait_ms)}
        <br />
        Median answer time:{" "}
        {stats.median_answer_ms === null
          ? "—"
          : formatDuration(stats.median_answer_ms)}{" "}
        ({stats.paused_turns} of {stats.answer_samples} turns had permission
        pauses; pause time excluded)
      </p>
      {editingRole ? (
        <form className="stack role-form" onSubmit={saveRole}>
          <label>
            Start from
            <select
              defaultValue=""
              onChange={(event) => {
                const preset = ROLE_PRESETS[event.target.value];
                if (preset) setRole(preset);
              }}
            >
              <option value="">Choose a preset</option>
              {Object.keys(ROLE_PRESETS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <textarea
              value={role}
              rows={4}
              placeholder="What this agent should do in this room"
              onChange={(event) => setRole(event.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={canEdit}
              onChange={(event) => setCanEdit(event.target.checked)}
            />
            Can edit files and repos
          </label>
          <div className="row">
            <button type="submit">Save role</button>
            <button
              type="button"
              className="secondary"
              onClick={() => setEditingRole(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="role">
            {agent.role ? (
              agent.role
            ) : (
              <span className="muted">No role set</span>
            )}
          </p>
          {agent.can_edit && <p className="muted">Can edit files and repos</p>}
          {!archived && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRole(agent.role);
                setCanEdit(agent.can_edit);
                setEditingRole(true);
              }}
            >
              Edit role
            </button>
          )}
        </>
      )}
      {agent.state === "not_responding" && (
        <p className="warning-text">
          It may be out of allowance, so check its app.
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
          Running · ends at {formatTime(agent.closes_at)}
        </p>
      )}
      {!archived && agent.closes_at !== null && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void act(() =>
              request(`/api/rooms/${roomId}/members/${agent.id}/extend-run`, {
                method: "POST",
                body: { minutes: 60 },
              }),
            )
          }
        >
          Extend 1 hour
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
