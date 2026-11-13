import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  useId,
  useMemo,
  Fragment,
  type KeyboardEvent,
} from "react";
import Markdown from "react-markdown";
import { EmojiPicker } from "./EmojiPicker";
import { Library } from "./Library";
import { ConvertRoles } from "./ConvertRoles";
import { RolePicker } from "./RolePicker";
import { TeamRoles } from "./TeamRoles";
import { DecisionReferences } from "./DecisionReferences";
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
  type RunWarning,
  type LeadReadInfo,
  type RoomAgent,
  type RoomState,
} from "./api";

const STATE_LABELS: Record<AgentState, string> = {
  not_joined: "Not joined",
  waiting: "Waiting for a turn",
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
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryDirty, setLibraryDirty] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [pageConnected, setPageConnected] = useState(false);
  const [serverRestarted, setServerRestarted] = useState(false);
  const instanceId = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [deletionNotice, setDeletionNotice] = useState("");

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const refresh = useCallback(async () => {
    try {
      const next = await request<Overview>("/api/overview");
      if (next.instance_id) {
        if (instanceId.current && instanceId.current !== next.instance_id)
          setServerRestarted(true);
        else if (!instanceId.current) instanceId.current = next.instance_id;
      }
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

  useEffect(() => {
    const unread =
      overview?.rooms.reduce(
        (sum, room) => sum + (room.unread_count ?? 0),
        0,
      ) ?? 0;
    document.title = unread ? `(${unread}) Konfab` : "Konfab";
    return () => {
      document.title = "Konfab";
    };
  }, [overview]);

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
        onSelect={(id) => {
          if (
            showLibrary &&
            libraryDirty &&
            !window.confirm("Discard unsaved editor changes?")
          )
            return;
          setSelectedId(id);
          setShowLibrary(false);
        }}
        onLibrary={() => setShowLibrary(true)}
        act={act}
      />
      <main className="chat">
        <RunWarningToasts overview={overview} act={act} />
        {deletionNotice && (
          <p className="banner" role="status">
            {deletionNotice}{" "}
            <button className="quiet" onClick={() => setDeletionNotice("")}>
              Dismiss
            </button>
          </p>
        )}
        {serverRestarted && (
          <p className="banner warning" role="status">
            Konfab restarted. Reload this page to use the latest version.{" "}
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </p>
        )}
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
        {showLibrary ? (
          <Library roomId={selectedId} onDirtyChange={setLibraryDirty} />
        ) : room ? (
          <Room
            key={room.room.id}
            state={room}
            act={act}
            pageConnected={pageConnected}
            onDeleted={setDeletionNotice}
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
  onLibrary,
  act,
}: {
  overview: Overview;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onLibrary: () => void;
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
        {(room.unread_count ?? 0) > 0 && (
          <span
            className={
              (room.attention_count ?? 0) > 0
                ? "unread-badge attention-badge"
                : "unread-badge"
            }
            aria-label={`${room.unread_count} unread${room.attention_count ? `, ${room.attention_count} mention you` : ""}`}
          >
            {room.attention_count ? "@ " : ""}
            {room.unread_count}
          </span>
        )}
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
      <button type="button" className="secondary" onClick={onLibrary}>
        ⚙ Manage library
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
  onDeleted,
}: {
  state: RoomState;
  act: Act;
  pageConnected: boolean;
  onDeleted: (message: string) => void;
}) {
  const { room, agents } = state;
  const [teamRolesOpen, setTeamRolesOpen] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [olderMessages, setOlderMessages] = useState<RoomState["messages"]>([]);
  const [olderReadInfo, setOlderReadInfo] = useState<LeadReadInfo | null>(null);
  const messages = useMemo(
    () =>
      [
        ...new Map(
          [...olderMessages, ...state.messages].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ].sort((a, b) => a.id - b.id),
    [olderMessages, state.messages],
  );
  const [anchor] = useState(state.read_info?.first_unread_id ?? null);
  const [entryLast] = useState(state.messages.at(-1)?.id ?? 0);
  const anchorId =
    anchor ??
    messages.find(
      (message) => message.sender_type === "agent" && message.id > entryLast,
    )?.id;
  const [locallyRead, setLocallyRead] = useState(new Set<number>());
  const [readingAbove, setReadingAbove] = useState(false);
  const pendingRead = useRef(new Set<number>());
  const seenHighlights = useRef(new Set<number>());
  const inFlightRead = useRef(new Set<number>());
  const visibleMessages = useRef(new Set<number>());
  const queueVisibleRef = useRef<() => void>(() => undefined);
  const initialScroll = useRef(false);
  const unreadCount = state.read_info?.unread_count ?? 0;
  const olderUnreadCount =
    unreadCount === 0
      ? 0
      : (olderReadInfo?.older_unread_count ??
        state.read_info?.older_unread_count ??
        0);
  const passes = state.passes ?? [];
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic);
  const [brief, setBrief] = useState(room.brief);
  const [projectPath, setProjectPath] = useState(room.project_path ?? "");
  const [parallelMentions, setParallelMentions] = useState(
    room.parallel_lead_mentions,
  );
  const [checkinMinutes, setCheckinMinutes] = useState<number | null>(
    room.checkin_minutes,
  );
  const listRef = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const timelineKey = `${messages.at(-1)?.id}-${passes.at(-1)?.id}-${state.permissions.at(-1)?.id}`;
  // On a time tie, a message comes first, because a pass follows what it answers.
  const timeline = useMemo(
    () =>
      [
        ...messages.map((message) => ({
          kind: "message" as const,
          ...message,
        })),
        ...passes.map((pass) => ({ kind: "pass" as const, ...pass })),
        ...state.permissions.map((permission) => ({
          kind: "permission" as const,
          ...permission,
        })),
      ].sort((a, b) => a.created_at - b.created_at),
    [messages, passes, state.permissions],
  );
  const [olderActivity, setOlderActivity] = useState<ActivityEvent[]>([]);
  const [hasOlderActivity, setHasOlderActivity] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RoomState["messages"] | null>(null);

  const flushReads = useCallback(async () => {
    const ids = [...pendingRead.current]
      .filter((id) => !inFlightRead.current.has(id))
      .slice(0, 200);
    if (!ids.length) return;
    ids.forEach((id) => {
      pendingRead.current.delete(id);
      inFlightRead.current.add(id);
    });
    await act(async () => {
      try {
        await request(`/api/rooms/${room.id}/read`, {
          method: "POST",
          body: { ids },
        });
        setTimeout(() => {
          ids.forEach((id) => seenHighlights.current.delete(id));
          setLocallyRead((previous) => new Set([...previous, ...ids]));
        }, 2000);
      } catch (error) {
        ids.forEach((id) => pendingRead.current.add(id));
        throw error;
      } finally {
        ids.forEach((id) => inFlightRead.current.delete(id));
      }
    });
  }, [act, room.id]);
  const markAllRead = useCallback(() => {
    void act(async () => {
      await request(`/api/rooms/${room.id}/read`, {
        method: "POST",
        body: { all: true },
      });
      setLocallyRead(
        (previous) => new Set([...previous, ...seenHighlights.current]),
      );
      seenHighlights.current.clear();
      pendingRead.current.clear();
      setOlderMessages((previous) =>
        previous.map((message) => ({ ...message, unread: false })),
      );
      setOlderReadInfo((previous) =>
        previous ? { ...previous, older_unread_count: 0 } : null,
      );
    });
  }, [act, room.id]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (!initialScroll.current) {
      initialScroll.current = true;
      const divider = list.querySelector<HTMLElement>(".new-divider");
      if (olderUnreadCount > 0) list.scrollTop = 0;
      else if (divider) list.scrollTop = divider.offsetTop - list.offsetTop;
      else list.scrollTop = list.scrollHeight;
      atBottom.current =
        list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    } else if (atBottom.current) list.scrollTop = list.scrollHeight;
  }, [timelineKey, olderUnreadCount]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const queueVisible = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus())
        return;
      for (const id of visibleMessages.current)
        if (!locallyRead.has(id)) {
          const bounds = document
            .getElementById(`message-${id}`)
            ?.getBoundingClientRect();
          if (
            !bounds ||
            bounds.bottom <= 0 ||
            bounds.top >= window.innerHeight ||
            bounds.right <= 0 ||
            bounds.left >= window.innerWidth
          )
            continue;
          pendingRead.current.add(id);
          seenHighlights.current.add(id);
        }
    };
    queueVisibleRef.current = queueVisible;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.messageId);
          if (entry.isIntersecting) visibleMessages.current.add(id);
          else visibleMessages.current.delete(id);
        }
        queueVisible();
      },
      { root: list, threshold: 0 },
    );
    list
      .querySelectorAll<HTMLElement>("[data-unread='true']")
      .forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      visibleMessages.current.clear();
    };
  }, [messages, locallyRead, flushReads]);

  useEffect(() => {
    const timer = setInterval(() => {
      queueVisibleRef.current();
      void flushReads();
    }, 1000);
    const onVisibility = () => {
      if (document.hidden) void flushReads();
      else queueVisibleRef.current();
    };
    const onFocus = () => queueVisibleRef.current();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("scroll", onFocus, true);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("scroll", onFocus, true);
      void flushReads();
    };
  }, [flushReads]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !(
          event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, form, [contenteditable='true']",
          )
        )
      )
        markAllRead();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markAllRead]);

  const loadOlder = () =>
    void act(async () => {
      const list = listRef.current;
      const beforeHeight = list?.scrollHeight ?? 0;
      const oldTop = list?.scrollTop ?? 0;
      const result = await request<{
        messages: RoomState["messages"];
        read_info: LeadReadInfo;
      }>(
        `/api/rooms/${room.id}/messages?before=${messages[0]?.id ?? Number.MAX_SAFE_INTEGER}`,
      );
      setOlderMessages((previous) => [...result.messages, ...previous]);
      setOlderReadInfo(result.read_info);
      requestAnimationFrame(() => {
        if (list) list.scrollTop = oldTop + list.scrollHeight - beforeHeight;
      });
    });
  const jumpToNew = () => {
    const list = listRef.current;
    if (!list) return;
    const edge = list.getBoundingClientRect().bottom;
    const nextUnread = [
      ...list.querySelectorAll<HTMLElement>("[data-unread='true']"),
    ].find((element) => element.getBoundingClientRect().top >= edge - 1);
    list.scrollTop = nextUnread
      ? nextUnread.offsetTop - list.offsetTop
      : list.scrollHeight;
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await request(`/api/rooms/${room.id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          topic,
          brief,
          parallel_lead_mentions: parallelMentions,
          checkin_minutes: checkinMinutes,
          ...(projectPath.trim() !== (room.project_path ?? "")
            ? { project_path: projectPath.trim() || null }
            : {}),
        },
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
      {teamRolesOpen && (
        <TeamRoles
          roomId={room.id}
          agents={agents}
          onClose={() => setTeamRolesOpen(false)}
          onApplied={() => void act(async () => {})}
        />
      )}
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
            <label>
              Project folder
              <input
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="Absolute path (optional)"
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={parallelMentions}
                onChange={(event) => setParallelMentions(event.target.checked)}
              />{" "}
              Answer my @mentions in parallel (experimental)
            </label>
            <label>
              Check-in interval while working
              <select
                value={checkinMinutes ?? "default"}
                onChange={(event) =>
                  setCheckinMinutes(
                    event.target.value === "default"
                      ? null
                      : Number(event.target.value),
                  )
                }
              >
                <option value="default">
                  Default ({room.checkin_default} min)
                </option>
                {[1, 2, 5, 10].map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "minute" : "minutes"}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              Shorter check-ins may improve responsiveness but use more agent
              allowance. An agent cannot check in while blocked on a long
              operation.
            </p>
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
                  disabled={!!state.format}
                  onClick={() => setFormatOpen(true)}
                >
                  Formats
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setTeamRolesOpen(true)}
                >
                  Roles
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setName(room.name);
                    setTopic(room.topic);
                    setBrief(room.brief);
                    setProjectPath(room.project_path ?? "");
                    setParallelMentions(room.parallel_lead_mentions);
                    setCheckinMinutes(room.checkin_minutes);
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
      {(formatOpen || state.format) && (
        <FormatPanel
          state={state}
          act={act}
          open={formatOpen}
          onClose={() => setFormatOpen(false)}
        />
      )}

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
                  {message.sender_type === "system"
                    ? "System"
                    : message.sender_type === "user"
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
          setReadingAbove(!atBottom.current);
        }}
      >
        {olderUnreadCount > 0 && (
          <li className="older-unread">
            {olderUnreadCount} older unread{" "}
            <button className="secondary" type="button" onClick={loadOlder}>
              Load older messages
            </button>
            <button
              className="quiet secondary"
              type="button"
              onClick={markAllRead}
            >
              Mark all read
            </button>
          </li>
        )}
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
            <Fragment key={`message-${item.id}`}>
              {item.id === anchorId && (
                <li className="new-divider">
                  <span>New messages</span>
                  <button
                    type="button"
                    className="quiet secondary"
                    onClick={markAllRead}
                  >
                    Mark all read
                  </button>
                </li>
              )}
              <li
                id={`message-${item.id}`}
                data-message-id={item.id}
                data-unread={
                  item.unread &&
                  item.id > (state.read_info?.cursor ?? 0) &&
                  !locallyRead.has(item.id)
                    ? "true"
                    : "false"
                }
                className={`${(item.unread || seenHighlights.current.has(item.id)) && !locallyRead.has(item.id) ? "unread-message" : ""} ${
                  item.mentions?.some(
                    (mention) => mention === "lead" || mention === "all",
                  )
                    ? "mentions-lead"
                    : ""
                }`}
              >
                <span className="sender">
                  {item.sender_type === "system"
                    ? "System"
                    : item.sender_type === "user"
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
            </Fragment>
          ),
        )}
      </ol>
      {readingAbove && unreadCount > 0 && (
        <button className="new-pill" type="button" onClick={jumpToNew}>
          ↓ {unreadCount} unread
        </button>
      )}

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
                  : event.type === "handoff_repaired" && event.handoff
                    ? `handed off to ${displayName(event.handoff.to)} (repair for #${event.handoff.source_message_id})`
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
        <div className="banner">
          This room is archived and is read-only.{" "}
          <DeleteRoom roomId={room.id} act={act} onDeleted={onDeleted} />
        </div>
      ) : (
        <Composer
          roomId={room.id}
          agents={agents}
          act={act}
          onSent={() => {
            atBottom.current = true;
          }}
        />
      )}
      <RoomRouting state={state} act={act} />
    </>
  );
}

function DeleteRoom({
  roomId,
  act,
  onDeleted,
}: {
  roomId: number;
  act: Act;
  onDeleted: (message: string) => void;
}) {
  const [preview, setPreview] = useState<null | {
    name: string;
    counts: {
      messages: number;
      decisions: number;
      attachments: number;
      attachment_bytes: number;
    };
  }>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void act(async () => {
            setPreview(await request(`/api/rooms/${roomId}/deletion-preview`));
            setName("");
          })
        }
      >
        Delete permanently…
      </button>
      {preview && (
        <section
          className="delete-room-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-room-title"
        >
          <h2 id="delete-room-title">Permanently delete #{preview.name}?</h2>
          <p>
            This removes {preview.counts.messages} messages,{" "}
            {preview.counts.decisions} decisions, {preview.counts.attachments}{" "}
            attachments ({preview.counts.attachment_bytes.toLocaleString()}{" "}
            recorded bytes), room activity, and related records. This cannot be
            undone.
          </p>
          <p>
            Backups, exports, other apps’ conversations, personal skills, roles,
            and project files are not removed.
          </p>
          <p>
            <a href={`/api/rooms/${roomId}/export`} download>
              Export to Markdown first
            </a>
          </p>
          <label>
            Type the room name to confirm
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="row">
            <button
              type="button"
              disabled={pending || name !== preview.name}
              onClick={() => {
                setPending(true);
                void act(async () => {
                  const result = await request<{
                    name: string;
                    counts: { messages: number };
                    files_removed: boolean;
                    compacted: boolean;
                  }>(`/api/rooms/${roomId}/delete`, {
                    method: "POST",
                    body: { name },
                  });
                  onDeleted(
                    `Deleted #${result.name} (${result.counts.messages} messages).${result.files_removed ? "" : " Attachment cleanup is pending."}${result.compacted ? "" : " Database compaction is pending."}`,
                  );
                }).finally(() => setPending(false));
              }}
            >
              Delete permanently
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function Composer({
  roomId,
  agents,
  act,
  onSent,
}: {
  roomId: number;
  agents: RoomAgent[];
  act: Act;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
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
        const uploaded = await uploadAttachment(roomId, file);
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
      await request(`/api/rooms/${roomId}/attachments/${attachment.id}`, {
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
      await request(`/api/rooms/${roomId}/messages`, {
        method: "POST",
        body: { body, attachment_ids: attachments.map((item) => item.id) },
      });
      setBody("");
      setAttachments([]);
      onSent();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
  };

  return (
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
                  src={`/api/rooms/${roomId}/attachments/${item.id}?inline=1`}
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
              (item) => item.kind === "file" && item.type.startsWith("image/"),
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

function AutoContinuation({ state, act }: { state: RoomState; act: Act }) {
  const routing = state.routing!;
  const item = routing.automatic;
  const [now, setNow] = useState(Date.now());
  const anchor = useRef({ local: Date.now(), server: item?.server_now ?? 0 });
  useEffect(() => {
    anchor.current = { local: Date.now(), server: item?.server_now ?? 0 };
    setNow(Date.now());
  }, [item?.id, item?.server_now]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const target = item
    ? (state.agents.find((agent) => agent.id === item.target_agent_id)
        ?.display_name ?? item.target_agent_id)
    : "";
  const left = item
    ? Math.max(
        0,
        Math.ceil(
          (item.due_at - (anchor.current.server + now - anchor.current.local)) /
            1000,
        ),
      )
    : 0;
  const reasons: Record<string, string> = {
    cap: "Stuck · needs you",
    paused: "Paused",
    limit: "Message limit reached",
    permission: "Waiting for approval",
    working: "Work in progress",
    queued: "Turn already queued",
    rejoin: "Needs rejoin",
  };
  return (
    <div>
      <button
        type="button"
        className="quiet"
        onClick={() =>
          void act(() =>
            request(`/api/rooms/${state.room.id}/auto-continue`, {
              method: "PUT",
              body: { enabled: !routing.auto_continue_enabled },
            }),
          )
        }
      >
        Automatic continuation: {routing.auto_continue_enabled ? "On" : "Off"}
      </button>
      {item && (
        <p aria-live="off">
          {item.blocked
            ? (reasons[item.blocked] ?? "Waiting")
            : left > 0
              ? `Auto-continue ${target} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
              : `Checking continuation for ${target}…`}{" "}
          <button
            type="button"
            className="quiet"
            onClick={() =>
              void act(() =>
                request(
                  `/api/rooms/${state.room.id}/auto-continue/${item.id}/cancel`,
                  { method: "POST" },
                ),
              )
            }
          >
            Cancel
          </button>
        </p>
      )}
    </div>
  );
}

function FormatPanel({
  state,
  act,
  open,
  onClose,
}: {
  state: RoomState;
  act: Act;
  open: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"review" | "debate">("review");
  const [topic, setTopic] = useState("");
  const [rounds, setRounds] = useState(2);
  const [author, setAuthor] = useState("");
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [pro, setPro] = useState("");
  const [con, setCon] = useState("");
  const [judge, setJudge] = useState("");
  const [error, setError] = useState("");
  const memberSelect = (
    label: string,
    value: string,
    set: (id: string) => void,
  ) => (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => set(event.target.value)}
        required
      >
        <option value="">Choose member</option>
        {state.agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.display_name} (@{agent.id})
          </option>
        ))}
      </select>
    </label>
  );
  const start = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const body = {
        kind,
        topic,
        rounds,
        ...(kind === "review" ? { author, reviewers } : { pro, con, judge }),
      };
      await request(`/api/rooms/${state.room.id}/formats`, {
        method: "POST",
        body,
      });
      onClose();
      await act(async () => {});
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const control = (action: "pause" | "resume" | "skip" | "end") => {
    if (
      (action === "skip" || action === "end") &&
      !window.confirm(
        action === "skip"
          ? "Skip this step? An active agent's late response will be rejected."
          : "End this format early?",
      )
    )
      return;
    void act(() =>
      request(`/api/rooms/${state.room.id}/formats/control`, {
        method: "POST",
        body: { action },
      }),
    );
  };
  const run = state.format;
  return (
    <section
      className="card format-panel"
      aria-label="Review and debate formats"
    >
      {run ? (
        <>
          <h3>
            {run.kind === "review" ? "Code review" : "Debate"} · {run.state}
          </h3>
          <p>{run.topic}</p>
          <p>
            Step {run.current_step + 1} of {run.step_count}: {run.step?.slot} ·{" "}
            {run.step?.agent_id} · round {run.step?.round} of {run.rounds}
          </p>
          <div className="row">
            <button
              type="button"
              onClick={() =>
                control(run.state === "active" ? "pause" : "resume")
              }
            >
              {run.state === "active" ? "Pause format" : "Resume format"}
            </button>
            <button type="button" onClick={() => control("skip")}>
              Skip step
            </button>
            <button type="button" onClick={() => control("end")}>
              End early
            </button>
          </div>
        </>
      ) : (
        open && (
          <form className="stack" onSubmit={(event) => void start(event)}>
            <h3>Start a format</h3>
            <label>
              Format
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as "review" | "debate")
                }
              >
                <option value="review">Code review</option>
                <option value="debate">Debate</option>
              </select>
            </label>
            <label>
              Topic or link
              <input
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                maxLength={1000}
                required
              />
            </label>
            <label>
              Rounds
              <input
                type="number"
                min={1}
                max={5}
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
                required
              />
            </label>
            {kind === "review" ? (
              <>
                {memberSelect("Author", author, setAuthor)}
                <fieldset>
                  <legend>Reviewers (1–3)</legend>
                  {state.agents.map((agent) => (
                    <label key={agent.id}>
                      <input
                        type="checkbox"
                        checked={reviewers.includes(agent.id)}
                        onChange={(event) =>
                          setReviewers(
                            event.target.checked
                              ? [...reviewers, agent.id]
                              : reviewers.filter((id) => id !== agent.id),
                          )
                        }
                      />
                      {agent.display_name}
                    </label>
                  ))}
                </fieldset>
              </>
            ) : (
              <>
                {memberSelect("Pro", pro, setPro)}
                {memberSelect("Con", con, setCon)}
                {memberSelect("Judge", judge, setJudge)}
              </>
            )}
            <p className="muted">
              Choose a different room member for each slot. Format turns take
              priority; other queued work resumes afterward.
            </p>
            {error && (
              <p role="alert" className="warning-text">
                {error}
              </p>
            )}
            <div className="row">
              <button type="submit">Start format</button>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )
      )}
    </section>
  );
}

function RoomRouting({ state, act }: { state: RoomState; act: Act }) {
  const routing = state.routing;
  if (!routing) return null;
  const name = (id: string) =>
    state.agents.find((agent) => agent.id === id)?.display_name ?? id;
  return (
    <section
      className={`routing-status${routing.no_continuation ? " needs-routing" : ""}`}
      aria-label="Conversation next step"
      aria-live="polite"
    >
      <AutoContinuation state={state} act={act} />
      {routing.suspended ? (
        <p>
          {state.room.archived
            ? "Room is archived."
            : state.room.on_break
              ? "Room is on break. Rejoin an agent to continue."
              : state.room.paused
                ? "Room is paused. Resume it to continue."
                : "All rooms are paused. Resume all rooms to continue."}
        </p>
      ) : (
        <>
          {routing.active && (
            <p>
              Taking a turn: <strong>{name(routing.active.agent_id)}</strong>
            </p>
          )}
          {routing.working.length > 0 && (
            <p>
              Reported background work: {routing.working.map(name).join(", ")}
            </p>
          )}
          {routing.queued.length > 0 && (
            <p>
              Next:{" "}
              {routing.queued
                .map(
                  (item) =>
                    `${name(item.agent_id)} (queued${item.repair_source_message_id !== null ? ` · repair for #${item.repair_source_message_id}` : ""}${!routing.eligible_agents.includes(item.agent_id) ? " · needs rejoin" : ""})`,
                )
                .join(" → ")}
            </p>
          )}
          {routing.no_continuation && (
            <>
              <p>
                {routing.automatic && !routing.automatic.blocked
                  ? "Automatic continuation is scheduled. You can also ask an agent to continue now."
                  : "⚠ No continuation queued. If work should continue, ask an agent below."}
              </p>
              <div className="row">
                {routing.eligible_agents.map((id) => (
                  <button
                    className="secondary"
                    type="button"
                    key={id}
                    onClick={() =>
                      void act(() =>
                        request(`/api/rooms/${state.room.id}/messages`, {
                          method: "POST",
                          body: {
                            body: `@${id} Please continue from the latest room discussion.`,
                          },
                        }),
                      )
                    }
                  >
                    Ask {name(id)} to continue
                  </button>
                ))}
              </div>
              {routing.eligible_agents.length === 0 && (
                <p className="muted">Rejoin an agent in its app to continue.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
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

function formatRemaining(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1000))} s left`;
  const minutes = Math.ceil(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left`
    : `${minutes} min left`;
}

function RunCountdown({ agent }: { agent: RoomAgent }) {
  const snapshot = useMemo(
    () => ({ clock: agent.run_clock, receivedAt: performance.now() }),
    [agent.run_clock],
  );
  const [, repaint] = useState(0);
  const remaining = snapshot.clock
    ? Math.max(
        0,
        snapshot.clock.remaining_ms -
          (snapshot.clock.paused ? 0 : performance.now() - snapshot.receivedAt),
      )
    : agent.saved_run_ms;
  const interval =
    remaining !== null && remaining !== undefined && remaining < 60_000
      ? 1000
      : 30_000;
  useEffect(() => {
    if (!snapshot.clock || snapshot.clock.paused) return;
    const timer = setInterval(() => repaint((value) => value + 1), interval);
    return () => clearInterval(timer);
  }, [snapshot, interval]);
  if (remaining === null || remaining === undefined) return null;
  const paused = snapshot.clock?.paused ?? true;
  return (
    <span
      className={
        remaining <= 5 * 60_000
          ? "countdown critical"
          : remaining <= 30 * 60_000
            ? "countdown warning-text"
            : "countdown muted"
      }
      title={
        !paused && agent.closes_at !== null
          ? `Ends at ${new Date(agent.closes_at).toLocaleString()}`
          : "Remaining time is frozen"
      }
    >
      {!snapshot.clock
        ? `On break · ${formatRemaining(remaining).replace(/left$/, "saved")}`
        : remaining <= 0 && !paused
          ? "Run window ended"
          : `${paused ? "Paused · " : ""}${formatRemaining(remaining)}`}
    </span>
  );
}

function NotificationSetting() {
  const [permission, setPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "unsupported",
  );
  if (permission === "unsupported")
    return (
      <p className="muted">
        Desktop notifications are unavailable in this browser.
      </p>
    );
  return (
    <>
      <button
        className="secondary"
        type="button"
        disabled={permission === "granted" || permission === "denied"}
        onClick={() => {
          void Notification.requestPermission()
            .then(setPermission)
            .catch(() => undefined);
        }}
      >
        {permission === "granted"
          ? "Notifications enabled"
          : permission === "denied"
            ? "Notifications blocked in browser"
            : "Enable notifications"}
      </button>
    </>
  );
}

function RunWarningToasts({ overview, act }: { overview: Overview; act: Act }) {
  const [toasts, setToasts] = useState<RunWarning[]>([]);
  const seen = useRef(new Set<number>());
  useEffect(() => {
    const latest = new Map<string, RunWarning>();
    for (const warning of overview.run_warnings ?? [])
      latest.set(warning.session_id, warning);
    for (const warning of latest.values()) {
      if (seen.current.has(warning.id)) continue;
      seen.current.add(warning.id);
      const deliver = () => {
        const key = `konfab.ui.v1.run-warning.${warning.session_id}.${warning.id}`;
        try {
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, "seen");
        } catch {
          /* Session-local deduplication still applies. */
        }
        setToasts((previous) => [
          ...previous.filter((item) => item.session_id !== warning.session_id),
          warning,
        ]);
        if (
          document.hidden &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          try {
            new Notification(
              `${warning.agent_id}: ${warning.threshold} min left in #${warning.room}`,
              { tag: `run-window-${warning.session_id}` },
            );
          } catch {
            /* The page toast remains available. */
          }
        }
      };
      if (navigator.locks)
        void navigator.locks.request("konfab-run-warning", deliver);
      else deliver();
    }
  }, [overview.run_warnings]);
  const active = new Set(
    (overview.run_warnings ?? []).map((warning) => warning.id),
  );
  return (
    <div className="run-toasts" aria-live="polite">
      {toasts
        .filter((warning) => active.has(warning.id))
        .map((warning) => (
          <div className="banner warning" key={warning.id}>
            <span>
              {warning.agent_id}: {warning.threshold} min left in #
              {warning.room}
            </span>
            <button
              className="quiet"
              type="button"
              onClick={() =>
                void act(async () => {
                  await request(
                    `/api/rooms/${warning.room_id}/members/${warning.agent_id}/extend-run`,
                    { method: "POST", body: { minutes: 60 } },
                  );
                  setToasts((previous) =>
                    previous.filter(
                      (item) => item.session_id !== warning.session_id,
                    ),
                  );
                })
              }
            >
              Extend 1 hour
            </button>
            <button
              className="quiet"
              type="button"
              aria-label={`Dismiss ${warning.agent_id} time warning`}
              onClick={() =>
                setToasts((previous) =>
                  previous.filter((item) => item.id !== warning.id),
                )
              }
            >
              Dismiss
            </button>
          </div>
        ))}
    </div>
  );
}

function usePanelPreference(
  key: string,
  fallback: boolean,
): [boolean, (open: boolean) => void] {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  let stored = fallback;
  try {
    const value = localStorage.getItem(key);
    if (value === "true" || value === "false") stored = value === "true";
  } catch {
    /* Storage may be unavailable in private browsing. */
  }
  return [
    choices[key] ?? stored,
    (open) => {
      setChoices((previous) => ({ ...previous, [key]: open }));
      try {
        localStorage.setItem(key, String(open));
      } catch {
        /* Keep the in-memory choice. */
      }
    },
  ];
}

function CollapsibleSection({
  title,
  accessibleLabel,
  preferenceKey,
  urgent = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  accessibleLabel?: string;
  preferenceKey: string;
  urgent?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [preferredOpen, setOpen] = usePanelPreference(
    preferenceKey,
    defaultOpen,
  );
  const open = urgent || preferredOpen;
  const id = useId();
  return (
    <section className="panel-section" aria-label={title}>
      <h2>
        <button
          className="section-toggle"
          aria-label={accessibleLabel}
          type="button"
          aria-expanded={open}
          aria-controls={id}
          disabled={urgent}
          title={urgent ? "Kept open while attention is needed" : undefined}
          onClick={() => setOpen(!open)}
        >
          <span>{title}</span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h2>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
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
  const [preferredOpen, setPanelOpen] = usePanelPreference(
    "konfab.ui.v1.panel",
    !window.matchMedia("(max-width: 900px)").matches,
  );
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!room?.agents.some((agent) => agent.working)) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [room?.agents]);
  const warning = overview.reports.some(
    (report) =>
      report.kind === "low_allowance" || report.kind === "out_of_allowance",
  );
  const staleWorking =
    room?.agents.some(
      (agent) =>
        agent.working &&
        Math.max(clock, Date.now()) - agent.working.updated_at >=
          agent.working.stale_after_ms,
    ) ?? false;
  const urgent = overview.permissions.length > 0;
  const attentionCount =
    (room?.agents.filter(
      (agent) =>
        agent.working &&
        Math.max(clock, Date.now()) - agent.working.updated_at >=
          agent.working.stale_after_ms,
    ).length ?? 0) +
    overview.reports.filter(
      (report) =>
        report.kind === "low_allowance" || report.kind === "out_of_allowance",
    ).length;
  const open = preferredOpen || urgent;
  const panelId = useId();
  return (
    <aside
      className={open ? "panel" : "panel panel-collapsed"}
      aria-label="Room details"
    >
      <button
        className="secondary panel-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={urgent}
        title={
          urgent
            ? "Kept open while attention is needed"
            : open
              ? "Collapse right panel"
              : "Open right panel"
        }
        onClick={() => setPanelOpen(!open)}
      >
        {open ? "»" : "«"}
        {!open && attentionCount > 0 && (
          <span
            className="rail-warning"
            aria-label={`${attentionCount} agent warnings`}
          >
            ⚠ {attentionCount}
          </span>
        )}
        <span className="sr-only">
          {open ? "Collapse right panel" : "Open right panel"}
        </span>
      </button>
      <div id={panelId} className="panel-content" hidden={!open}>
        <CollapsibleSection
          title={`Lead · ${pageConnected ? "connected" : "disconnected"}`}
          preferenceKey="konfab.ui.v1.section.lead"
          defaultOpen={false}
        >
          <p title="This status reflects the page connection, not whether a person is present.">
            {pageConnected ? "Page connected" : "Page disconnected"}
          </p>
          <NotificationSetting />
        </CollapsibleSection>
        {overview.permissions.length > 0 && (
          <CollapsibleSection
            title={`Permissions · ${overview.permissions.length} pending`}
            preferenceKey="konfab.ui.v1.section.permissions"
            urgent
          >
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
                      className={
                        decision === "denied" ? "secondary" : undefined
                      }
                      onClick={() =>
                        void act(() =>
                          request(
                            `/api/permissions/${permission.id}/decision`,
                            {
                              method: "POST",
                              body: { decision },
                            },
                          ),
                        )
                      }
                    >
                      {decision === "approved" ? "Approve" : "Deny"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CollapsibleSection>
        )}
        {room && <Decisions key={room.room.id} room={room} act={act} />}
        {room && (
          <Agents
            overview={overview}
            room={room}
            act={act}
            urgent={warning || staleWorking}
          />
        )}
      </div>
    </aside>
  );
}

function Decisions({ room, act }: { room: RoomState; act: Act }) {
  const [adding, setAdding] = useState(false);
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
      setAdding(false);
    });
  };
  return (
    <CollapsibleSection
      title={`Decisions (${room.decisions.length})`}
      preferenceKey="konfab.ui.v1.section.decisions"
    >
      {!room.room.archived && (
        <button
          className="secondary"
          type="button"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          {adding ? "Cancel new decision" : "+ Add decision"}
        </button>
      )}
      {!room.room.archived && adding && (
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
          decisionIds={room.decisions.map((item) => item.id)}
          roomId={room.room.id}
          archived={room.room.archived}
          act={act}
        />
      ))}
    </CollapsibleSection>
  );
}

function DecisionCard({
  decision,
  decisionIds,
  roomId,
  archived,
  act,
}: {
  decision: Decision;
  decisionIds: number[];
  roomId: number;
  archived: boolean;
  act: Act;
}) {
  const [expanded, setExpanded] = useState(false);
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
    <div
      id={`decision-${decision.id}`}
      className="card decision-card"
      tabIndex={-1}
    >
      <p>
        <strong>
          #{decision.id} ·{" "}
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
      <p
        className={
          expanded ||
          (decision.body.length <= 100 && !decision.body.includes("\n"))
            ? "decision-body"
            : "decision-body clipped"
        }
      >
        <DecisionReferences body={decision.body} decisionIds={decisionIds} />
      </p>
      {(decision.body.length > 100 || decision.body.includes("\n")) && (
        <button
          className="quiet secondary"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
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

type RolePreview = {
  id: string;
  revision_id: string;
  number: number;
  title: string;
  role_md: string;
  skills: Array<{ name: string; reviewed: number }>;
};

type RoleOption = {
  id: string;
  revision_id: string;
  name: string;
  title: string;
};

function Agents({
  overview,
  room,
  act,
  urgent,
}: {
  overview: Overview;
  room: RoomState;
  act: Act;
  urgent: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [newApp, setNewApp] = useState("");
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
  const appCount = (appId: string) =>
    overview.agents.filter((agent) => agent.app_id === appId).length;
  const appFull = (appId: string) =>
    appCount(appId) >= overview.max_agents_per_app;
  const openApps = overview.apps.filter((app) => !appFull(app.id));
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
  const openAdd = () => {
    setNewApp(openApps[0]?.id ?? "");
    setNewName("");
    setNewId("");
    setIdEdited(false);
    setNewRole("");
    previewRequest.current += 1;
    setRolePreview(null);
    setConfirmedRevision("");
    setAddToRoom(true);
    setAgentError("");
    setAdding(true);
    request<{ roles: RoleOption[] }>("/api/roles")
      .then((result) => setRoles(result.roles))
      .catch(() => setRoles([]));
  };
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
          ...(addToRoom ? { room_id: room.room.id } : {}),
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
      setAdding(false);
      await act(async () => {});
    } catch (error) {
      setAgentError(errorMessage(error));
    }
  };
  const members = room.agents.map((agent) => agent.id);
  const setMembers = (next: string[]) =>
    void act(() =>
      request(`/api/rooms/${room.room.id}/members`, {
        method: "PUT",
        body: { members: next },
      }),
    );

  return (
    <CollapsibleSection
      title={`Agents · ${room.agents.filter((agent) => agent.state === "working" || agent.working).length} working · ${room.agents.length} total`}
      preferenceKey="konfab.ui.v1.section.agents"
      urgent={urgent}
    >
      <div className="row agent-toolbar">
        <button
          type="button"
          disabled={room.room.archived || openApps.length === 0}
          title={
            openApps.length === 0
              ? `Every app has ${overview.max_agents_per_app} agents`
              : undefined
          }
          onClick={() => (adding ? setAdding(false) : openAdd())}
        >
          + Add agent
        </button>
      </div>
      {adding && (
        <form className="stack card" onSubmit={(event) => void addAgent(event)}>
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
                      Review{" "}
                      {roleUnreviewed.map((skill) => skill.name).join(", ")} in
                      Manage library before assigning this role, or add the
                      agent with no role.
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
                      I reviewed this role (rev {rolePreview.number}) and want
                      to assign it
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
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <p className="muted">
            Next: use the new card's Copy join prompt in a new conversation in
            that app.
          </p>
        </form>
      )}
      <section className="app-agent-group">
        {overview.agents.map((agent) => {
          const member = room.agents.find((item) => item.id === agent.id);
          const lastPost = [...room.messages]
            .reverse()
            .find(
              (message) =>
                message.sender_type === "agent" &&
                message.sender_id === agent.id,
            );
          return (
            <div className="card compact-agent" key={agent.id}>
              <div className="agent-heading">
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
                  <strong>
                    {agent.display_name}{" "}
                    <small className="muted">
                      @{agent.id}
                      {agent.is_default ? " · default" : ""}
                    </small>
                  </strong>
                </label>
                <span className="agent-chips">
                  <span className="chip" title="App that runs this agent">
                    App: {agent.app_name}
                  </span>
                  {member && (
                    <span className="chip" title="Role in this room">
                      Role:{" "}
                      {member.role_pack_label ??
                        (member.role?.trim() ? "custom text" : "none")}
                    </span>
                  )}
                </span>
                {member && (
                  <>
                    <span className={`state ${member.state}`}>
                      {room.queued.includes(member.id) &&
                      (member.state === "working" ||
                        (member.state === "queued" && member.working))
                        ? "Working · reply queued"
                        : STATE_LABELS[member.state]}
                    </span>
                    {member.state === "waiting" &&
                      !member.working &&
                      lastPost && (
                        <span
                          className="muted"
                          title={new Date(lastPost.created_at).toLocaleString()}
                        >
                          last post{" "}
                          {Math.max(
                            0,
                            Math.floor(
                              (Date.now() - lastPost.created_at) / 60000,
                            ),
                          )}{" "}
                          min ago
                        </span>
                      )}
                    <RunCountdown agent={member} />
                  </>
                )}
              </div>
              {room.locks
                .filter((lock) => lock.agent_id === agent.id)
                .map((lock) => (
                  <div className="lock-chip" key={lock.resource}>
                    <span>
                      🔒 Advisory lock: {lock.resource} · {lock.purpose} ·
                      expires {formatTime(lock.expires_at)}
                    </span>{" "}
                    {!room.room.archived && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Force-release the advisory lock ${lock.resource}? The holder may still be writing.`,
                            )
                          )
                            void act(() =>
                              request(
                                `/api/rooms/${room.room.id}/locks/release`,
                                {
                                  method: "POST",
                                  body: { resource: lock.resource },
                                },
                              ),
                            );
                        }}
                      >
                        Force-release
                      </button>
                    )}
                  </div>
                ))}
              {overview.reports
                .filter(
                  (report) =>
                    report.agent_id === agent.id &&
                    report.room === room.room.name &&
                    report.kind !== "other",
                )
                .map((report) => (
                  <p className="warning-text" key={report.id}>
                    {report.kind === "out_of_allowance"
                      ? "Out of allowance"
                      : "Low allowance"}
                    {report.detail ? `: ${report.detail}` : ""}
                  </p>
                ))}
              {!agent.is_default && <AgentManagement agent={agent} act={act} />}
              {member ? (
                <AgentDetails
                  agent={member}
                  replyQueued={room.queued.includes(member.id)}
                  peers={room.agents}
                  roomId={room.room.id}
                  archived={room.room.archived}
                  rolePickerEnabled={overview.ui?.role_picker ?? false}
                  act={act}
                />
              ) : (
                <p className="muted">Not in this room</p>
              )}
            </div>
          );
        })}
      </section>
    </CollapsibleSection>
  );
}

function AgentManagement({
  agent,
  act,
}: {
  agent: Overview["agents"][number];
  act: Act;
}) {
  const [name, setName] = useState(agent.display_name);
  return (
    <details>
      <summary>Manage agent</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(() =>
            request(`/api/agents/${encodeURIComponent(agent.id)}`, {
              method: "PATCH",
              body: { display_name: name },
            }),
          );
        }}
      >
        <label>
          Display name{" "}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
          />
        </label>
        <button type="submit">Rename</button>
      </form>
      <button
        type="button"
        onClick={() => {
          if (
            window.confirm(
              `Remove ${agent.display_name}? Its history will remain.`,
            )
          )
            void act(() =>
              request(`/api/agents/${encodeURIComponent(agent.id)}`, {
                method: "DELETE",
              }),
            );
        }}
      >
        Remove agent
      </button>
    </details>
  );
}

function AgentDetails({
  agent,
  replyQueued,
  peers,
  roomId,
  archived,
  rolePickerEnabled,
  act,
}: {
  agent: RoomAgent;
  replyQueued: boolean;
  peers: RoomAgent[];
  roomId: number;
  archived: boolean;
  rolePickerEnabled: boolean;
  act: Act;
}) {
  const [clock, setClock] = useState(Date.now);
  const workingUpdatedAt = agent.working?.updated_at;
  useEffect(() => {
    if (workingUpdatedAt === undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [workingUpdatedAt]);
  const workingElapsed = agent.working
    ? Math.max(0, Math.max(clock, Date.now()) - agent.working.updated_at)
    : 0;
  const workingStale = agent.working
    ? workingElapsed >= agent.working.stale_after_ms
    : false;
  const [copied, setCopied] = useState(false);
  const { stats } = agent;
  const [editingRole, setEditingRole] = useState(false);
  const [choosingRole, setChoosingRole] = useState(false);
  const [swappingRole, setSwappingRole] = useState(false);
  const [availableUpdates, setAvailableUpdates] = useState<
    Array<{ name: string; status: string }>
  >([]);
  useEffect(() => {
    let active = true;
    void request<{ updates: Array<{ name: string; status: string }> }>(
      `/api/rooms/${roomId}/members/${encodeURIComponent(agent.id)}/role-updates`,
    )
      .then((result) => {
        if (active)
          setAvailableUpdates(
            result.updates.filter(
              (item) => item.status === "changed" || item.status === "removed",
            ),
          );
      })
      .catch(() => {
        if (active) setAvailableUpdates([]);
      });
    return () => {
      active = false;
    };
  }, [roomId, agent.id, agent.role, agent.role_pack_label]);
  const [convertingRole, setConvertingRole] = useState(false);
  const [role, setRole] = useState(agent.role);
  const [canEdit, setCanEdit] = useState(agent.can_edit);
  const [rolePacks, setRolePacks] = useState<
    Array<{
      id: string;
      revision_id: string;
      title: string;
      library_id: string;
    }>
  >([]);
  const [rolePack, setRolePack] = useState("");
  const [roleNotes, setRoleNotes] = useState("");
  const [packPreview, setPackPreview] = useState("");
  const [packSkills, setPackSkills] = useState<
    Array<{
      name: string;
      reviewed: number;
      skill_id: string;
      skill_revision_id: string;
    }>
  >([]);
  const [reviewSkill, setReviewSkill] = useState<null | {
    skill_id: string;
    revision_id: string;
    text: string;
    files: Array<{ path: string; size: number }>;
  }>(null);
  const [assignmentRevision, setAssignmentRevision] = useState<
    number | undefined
  >();

  const saveRole = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await request(`/api/rooms/${roomId}/members/${agent.id}`, {
        method: "PUT",
        body: {
          role,
          can_edit: canEdit,
          base_role_revision: assignmentRevision,
        },
      });
      setEditingRole(false);
    });
  };

  return (
    <>
      {agent.state === "not_responding" && (
        <p className="warning-text">
          It may be out of allowance, so check its app.
        </p>
      )}
      {agent.working && (
        <p className={workingStale ? "warning-text" : "muted"}>
          {workingStale
            ? `Working (no update for ${Math.floor(workingElapsed / 60000)} min)`
            : `Working · ${Math.floor(workingElapsed / 60000)} min`}
          : {replyQueued ? "will reply after this: " : ""}
          {agent.working.detail}
        </p>
      )}
      {agent.pending_mention_since != null && (
        <p className="muted">
          Mention queued · since {formatTime(agent.pending_mention_since)}
          {agent.working &&
          agent.working.updated_at > agent.pending_mention_since
            ? ` · last working status ${formatTime(agent.working.updated_at)}`
            : ""}
        </p>
      )}
      {agent.bridge_outdated && <p className="warning">Reload connector</p>}
      {availableUpdates.length > 0 && (
        <p className="muted">
          {availableUpdates
            .map(
              (item) =>
                `${item.name}: ${item.status === "removed" ? "Removed from source" : "Update available"}`,
            )
            .join(" · ")}
          . Current assignments stay pinned.
        </p>
      )}
      {!archived && (
        <details>
          <summary>Role actions</summary>
          <button type="button" onClick={() => setSwappingRole(true)}>
            Swap role…
          </button>
        </details>
      )}
      {swappingRole && (
        <TeamRoles
          roomId={roomId}
          agents={peers}
          selected={agent.id}
          onClose={() => setSwappingRole(false)}
          onApplied={() => void act(async () => {})}
        />
      )}
      {choosingRole && (
        <RolePicker
          roomId={roomId}
          agentId={agent.id}
          agentName={agent.display_name}
          onClose={() => setChoosingRole(false)}
          onAssigned={() => void act(async () => {})}
        />
      )}
      {convertingRole && (
        <ConvertRoles
          roomId={roomId}
          agentId={agent.id}
          onClose={() => setConvertingRole(false)}
        />
      )}
      <CollapsibleSection
        title="Details"
        accessibleLabel={`${agent.display_name} details`}
        preferenceKey={`konfab.ui.v1.agent.${agent.id}.details`}
        defaultOpen={false}
        urgent={editingRole}
      >
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
              Role pack
              <select
                value={rolePack}
                onChange={(event) => {
                  const id = event.target.value;
                  setRolePack(id);
                  setPackPreview("");
                  setPackSkills([]);
                  setReviewSkill(null);
                  if (id)
                    void request<{
                      role_md: string;
                      skills: Array<{
                        name: string;
                        reviewed: number;
                        skill_id: string;
                        skill_revision_id: string;
                      }>;
                    }>(`/api/roles/${encodeURIComponent(id)}`).then(
                      (detail) => {
                        setPackPreview(detail.role_md);
                        setPackSkills(detail.skills);
                      },
                    );
                }}
              >
                <option value="">Custom text</option>
                {rolePacks.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.title} ·{" "}
                    {pack.library_id === "builtin" ? "built-in" : "personal"}
                  </option>
                ))}
              </select>
            </label>
            {rolePack && (
              <>
                <section>
                  <h4>Preview role</h4>
                  <pre>{packPreview}</pre>
                  {packSkills.map((skill) => (
                    <p key={skill.name}>
                      {skill.name} ·{" "}
                      {skill.reviewed
                        ? "Reviewed"
                        : "Review this skill before assignment"}
                      {!skill.reviewed && (
                        <button
                          type="button"
                          onClick={() =>
                            void act(async () => {
                              const data = await request<{
                                content_base64: string;
                              }>(
                                `/api/library/skills/${skill.skill_id}/revisions/${skill.skill_revision_id}/files?path=SKILL.md`,
                              );
                              const listing = await request<{
                                files: Array<{ path: string; size: number }>;
                              }>(
                                `/api/library/skills/${skill.skill_id}/revisions/${skill.skill_revision_id}`,
                              );
                              setReviewSkill({
                                skill_id: skill.skill_id,
                                revision_id: skill.skill_revision_id,
                                files: listing.files,
                                text: new TextDecoder().decode(
                                  Uint8Array.from(
                                    atob(data.content_base64),
                                    (c) => c.charCodeAt(0),
                                  ),
                                ),
                              });
                            })
                          }
                        >
                          Review now
                        </button>
                      )}
                    </p>
                  ))}
                  {reviewSkill && (
                    <section>
                      <h4>Skill revision preview</h4>
                      <pre>{reviewSkill.text}</pre>
                      {reviewSkill.files.map((file) => (
                        <p key={file.path}>
                          {file.path} ({file.size} bytes){" "}
                          <button
                            type="button"
                            onClick={() =>
                              void act(async () => {
                                const data = await request<{
                                  content_base64: string;
                                }>(
                                  `/api/library/skills/${reviewSkill.skill_id}/revisions/${reviewSkill.revision_id}/files?path=${encodeURIComponent(file.path)}`,
                                );
                                setReviewSkill({
                                  ...reviewSkill,
                                  text: new TextDecoder().decode(
                                    Uint8Array.from(
                                      atob(data.content_base64),
                                      (c) => c.charCodeAt(0),
                                    ),
                                  ),
                                });
                              })
                            }
                          >
                            View file
                          </button>
                        </p>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          void act(async () => {
                            await request(
                              `/api/library/skills/${reviewSkill.skill_id}/reviews/${reviewSkill.revision_id}`,
                              { method: "PUT" },
                            );
                            setPackSkills(
                              packSkills.map((skill) =>
                                skill.skill_revision_id ===
                                reviewSkill.revision_id
                                  ? { ...skill, reviewed: 1 }
                                  : skill,
                              ),
                            );
                            setReviewSkill(null);
                          })
                        }
                      >
                        Mark this revision reviewed
                      </button>
                    </section>
                  )}
                  <p>Room notes: {roleNotes || "None"}</p>
                </section>
                <label>
                  Room notes
                  <textarea
                    value={roleNotes}
                    onChange={(event) => setRoleNotes(event.target.value)}
                    maxLength={4000}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      const pack = rolePacks.find(
                        (item) => item.id === rolePack,
                      );
                      if (!pack) return;
                      await request(
                        `/api/rooms/${roomId}/members/${agent.id}/role-pack`,
                        {
                          method: "PUT",
                          body: {
                            role_id: pack.id,
                            role_revision_id: pack.revision_id,
                            notes: roleNotes,
                            base_revision: assignmentRevision,
                            can_edit: canEdit,
                          },
                        },
                      );
                      setEditingRole(false);
                    })
                  }
                >
                  Assign role pack
                </button>
              </>
            )}
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
              {!rolePack && <button type="submit">Save role</button>}
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
            {agent.can_edit && (
              <p className="muted">Can edit files and repos</p>
            )}
          </>
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
      </CollapsibleSection>
      <div className="agent-actions">
        {!archived && !agent.role_pack_label && !!agent.role.trim() && (
          <button
            type="button"
            className="secondary"
            onClick={() => setConvertingRole(true)}
          >
            Save as role pack
          </button>
        )}
        {!archived && agent.role_can_revert && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void act(async () => {
                const current = await request<{
                  assignment: { revision: number; can_revert: boolean };
                }>(`/api/rooms/${roomId}/members/${agent.id}/role-preview`);
                if (!current.assignment.can_revert)
                  throw new Error(
                    "No unchanged converted assignment is available to revert",
                  );
                if (!window.confirm("Restore the original custom role text?"))
                  return;
                await request(
                  `/api/rooms/${roomId}/members/${agent.id}/revert-conversion`,
                  {
                    method: "POST",
                    body: { base_revision: current.assignment.revision },
                  },
                );
              })
            }
          >
            Revert to custom text
          </button>
        )}
        {!archived && rolePickerEnabled && (
          <button
            type="button"
            className="secondary"
            onClick={() => setChoosingRole(true)}
          >
            Change role
          </button>
        )}
        {!archived && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setRole(agent.role);
              setCanEdit(agent.can_edit);
              setEditingRole(true);
              void request<{
                roles: Array<{
                  id: string;
                  revision_id: string;
                  title: string;
                  library_id: string;
                }>;
              }>("/api/roles").then((result) => setRolePacks(result.roles));
              void request<{
                assignment: null | {
                  role_id?: string;
                  notes?: string;
                  revision: number;
                };
              }>(`/api/rooms/${roomId}/members/${agent.id}/role-preview`).then(
                (result) => {
                  setRolePack(result.assignment?.role_id ?? "");
                  setRoleNotes(result.assignment?.notes ?? "");
                  setAssignmentRevision(result.assignment?.revision);
                  if (result.assignment?.role_id)
                    void request<{
                      role_md: string;
                      skills: typeof packSkills;
                    }>(
                      `/api/roles/${encodeURIComponent(result.assignment.role_id)}`,
                    ).then((detail) => {
                      setPackPreview(detail.role_md);
                      setPackSkills(detail.skills);
                    });
                },
              );
            }}
          >
            Edit role
          </button>
        )}
        {!archived &&
          (agent.closes_at !== null || agent.saved_run_ms != null) && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void act(() =>
                  request(
                    `/api/rooms/${roomId}/members/${agent.id}/extend-run`,
                    {
                      method: "POST",
                      body: { minutes: 60 },
                    },
                  ),
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
      </div>
    </>
  );
}
