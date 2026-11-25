import { useEffect, useId, useState } from "react";
import { JoinPrompts } from "./ContactNotice";
import { Modal } from "./Modal";
import { request, type RejoinState, type RoomAgent } from "./api";

type Act = (action: () => Promise<unknown>) => Promise<void>;
type Agent = Pick<
  RoomAgent,
  "id" | "display_name" | "state" | "rejoin" | "join_prompt" | "rejoin_prompt"
>;
/** What a click may have to change first, and what else starts by it. */
export type RoomNow = {
  id: number;
  paused: boolean;
  on_break: boolean;
  /** Names of the agents with a queued turn. */
  queued: string[];
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const EARLIER =
  "Another prompt may already be waiting there. Send a new one? Only the newest can rejoin.";
export const EARLIER_NOTE =
  "an earlier prompt may still be there; only the newest can rejoin";
export const CANCEL_HELP = {
  codex:
    "Cancel closes Konfab's request. It can't take back the prompt in Codex: that may still start a short turn, which will be told to end.",
  claude:
    "Cancel closes Konfab's request. It can't take back the wake-up: that may still start a short turn, which will be told to end.",
};
export const PASTE_WARNING =
  "It may still come back by itself. Pasting this then replaces its new session: a lock it holds is released and a running turn is queued again.";
const NAME = { codex: "Codex", claude: "Claude" };
const SLOW_MS = 20_000;
const appOf = (rejoin: RejoinState) => rejoin.app ?? "codex";
const AWAY = [
  "not_responding",
  "stopped",
  "window_ended",
  "on_break",
  "not_joined",
];
/** Never offered where a paste would replace a session that is in use. */
const isAway = (agent: Pick<RoomAgent, "state">) => AWAY.includes(agent.state);

const WHY: Record<string, string> = {
  connected: "Available when the agent is away.",
  no_watcher: "Its watcher isn't running, so paste the prompt.",
  unavailable: "The Codex command can't be used; npm run doctor says why.",
  elsewhere: "Its conversation is in another room now.",
  archived: "The room is archived.",
  watchers_full:
    "Too many old watchers may still be running, so no new one is started. Closing Claude normally ends them; restarting the computer always does.",
};
const READY = {
  codex:
    "Experimental. Asks Codex to bring its conversation back; uses its allowance.",
  claude:
    "Experimental. Wakes its conversation in Claude; uses its allowance. After Stop in Claude it may hold back.",
};

/** What has become of the lead's request, in words. */
export function rejoinText(rejoin: RejoinState): string | null {
  const asked = rejoin.request;
  if (!asked) return null;
  const app = appOf(rejoin);
  if (asked.state === "closed") {
    if (asked.declined)
      return `It says it was stopped in ${NAME[app]}, so it didn't come back. Paste the rejoin prompt there.`;
    return app === "claude"
      ? asked.refused
        ? "Its watcher didn't take it; nothing was sent."
        : "Rejoin closed. A wake-up may still come; it can start a short turn, but can't rejoin."
      : asked.refused
        ? "Codex didn't take it; nothing is waiting there."
        : "Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.";
  }
  if (asked.state === "joined")
    return asked.slow
      ? `Joined, but not waiting yet. Look at its conversation in ${NAME[app]}, or paste the rejoin prompt.`
      : "Joined · waiting for its first check.";
  return `Rejoin asked ${clock(asked.asked_at)} · ${
    asked.unsure
      ? `Konfab couldn't tell whether ${app === "codex" ? "Codex" : "its watcher"} took it.`
      : asked.slow
        ? "not back yet."
        : "waiting."
  }`;
}

/** What to do if it doesn't come by itself. Said at once, not later. */
export function rejoinHint(rejoin: RejoinState): string | null {
  const asked = rejoin.request;
  if (asked?.state !== "waiting") return null;
  const more = asked.slow
    ? " Otherwise it may ask you something there, or have reached a limit."
    : "";
  return appOf(rejoin) === "codex"
    ? `If Codex shows “Queue paused”, press Resume there.${more}`
    : `If you pressed Stop in Claude, it may hold back: paste the prompt there.${more}`;
}

/** Whether the card has these controls, which then have the prompts. */
export function rejoinShown(
  agent: Pick<RoomAgent, "state" | "rejoin">,
): boolean {
  const { rejoin, state } = agent;
  if (!rejoin) return false;
  if (rejoin.request) return true;
  if (!AWAY.includes(state)) return false;
  return rejoin.offer ? rejoin.offer !== "connected" : !!rejoin.can_open;
}

/** What has to be changed in the room for it, or null if that isn't enough. */
function toOpen(
  rejoin: RejoinState,
  room: RoomNow,
): ("pause" | "break")[] | null {
  if (rejoin.offer === "ready") return [];
  if (rejoin.then !== "ready" || rejoin.all_paused) return null;
  return [
    ...(room.paused ? (["pause"] as const) : []),
    ...(room.on_break ? (["break"] as const) : []),
  ];
}

const openTitle = (open: ("pause" | "break")[]): string =>
  open.length === 2
    ? "Resume, end the break and rejoin"
    : open[0] === "pause"
      ? "Resume and rejoin"
      : open[0] === "break"
        ? "End the break and rejoin"
        : "Rejoin agents";

type Opened = { opened: boolean; here: boolean };

/**
 * Asks the app to come to the front, and copies the prompt if its label says
 * so. Two steps with a result each; neither stops the other.
 */
export function OpenApp({
  roomId,
  agent,
  copy,
  primary,
  act,
}: {
  roomId: number;
  agent: Agent;
  copy: boolean;
  primary: boolean;
  act: Act;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [byHand, setByHand] = useState(false);
  const rejoin = agent.rejoin!;
  const app = NAME[appOf(rejoin)];
  const opens = rejoin.can_open ?? false;
  const run = () => {
    if (busy) return;
    setBusy(true);
    setByHand(false);
    setText("");
    // First, while the click still counts for the browser.
    const copied = copy
      ? Promise.resolve()
          .then(() => navigator.clipboard.writeText(agent.rejoin_prompt))
          .then(
            () => true,
            () => false,
          )
      : null;
    void act(async () => {
      const result = await request<Opened>(
        `/api/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/open`,
        { method: "POST" },
      );
      const done = copied === null ? null : await copied;
      if (result.here) {
        setText(`It has just come back.${copy ? " Don't paste." : ""}`);
        return;
      }
      setByHand(done === false);
      setText(
        [
          done === null
            ? ""
            : done
              ? "Prompt copied."
              : "Couldn't copy the prompt; copy it by hand.",
          !opens
            ? ""
            : result.opened
              ? `Asked ${app} to open. Choose this agent's conversation${copy ? " and paste" : ""}.`
              : `Couldn't ask ${app} to open. Open it and choose this agent's conversation.`,
          copy && rejoin.request?.state === "waiting" ? PASTE_WARNING : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }).finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className={primary ? "" : "secondary"}
        // Not `disabled`, which would lose the focus.
        aria-disabled={busy}
        onClick={run}
      >
        {!opens
          ? "Copy the prompt"
          : copy
            ? `Open ${app} and copy the prompt`
            : `Open ${app}`}
      </button>
      <span className="open-result" aria-live="polite">
        {text}
      </span>
      {byHand && (
        <textarea
          aria-label="Rejoin prompt"
          readOnly
          rows={4}
          value={agent.rejoin_prompt}
          ref={(element) => element?.select()}
        />
      )}
    </>
  );
}

/** On an agent's card. The manual prompts are there in every state. */
export function RejoinControls({
  room,
  agent,
  act,
}: {
  room: RoomNow;
  agent: Agent;
  act: Act;
}) {
  const { rejoin } = agent;
  const roomId = room.id;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [, repaint] = useState(0);
  const help = useId();
  const sentAt =
    rejoin?.request?.state === "waiting" ? rejoin.request.asked_at : null;
  useEffect(() => {
    if (sentAt === null) return;
    const left = sentAt + SLOW_MS - Date.now();
    if (left <= 0 || left > SLOW_MS) return;
    const timer = setTimeout(() => repaint((value) => value + 1), left);
    return () => clearTimeout(timer);
  }, [sentAt]);
  if (!rejoin || (!rejoinShown(agent) && !rejoin.offer)) return null;
  const now: RejoinState =
    rejoin.request && sentAt !== null && Date.now() - sentAt >= SLOW_MS
      ? { ...rejoin, request: { ...rejoin.request, slow: true } }
      : rejoin;
  const app = appOf(rejoin);
  const path = `/api/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/rejoin`;
  const run = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void act(action).finally(() => setBusy(false));
  };
  const text = rejoinText(now);
  const hint = rejoinHint(now);
  const resting = rejoin.resting ?? 0;
  const waiting = rejoin.request?.state === "waiting";
  const slow = now.request?.slow === true;
  const open = toOpen(rejoin, room);
  // Also one whose button would need something else first.
  const connected =
    rejoin.offer === "connected" ||
    (rejoin.offer !== null && !rejoin.request && !isAway(agent));
  const elsewhere = rejoin.offer === "elsewhere" || rejoin.then === "elsewhere";
  const copyable =
    !waiting &&
    !connected &&
    !elsewhere &&
    open === null &&
    rejoin.offer !== "archived" &&
    (isAway(agent) || (rejoin.request?.state === "joined" && slow));
  const reason = rejoin.then ?? rejoin.offer;
  const why = [
    rejoin.offer === "paused" && open === null
      ? rejoin.all_paused
        ? "All rooms are paused; resume them first."
        : "The room is paused."
      : "",
    rejoin.offer === "on_break" && open === null
      ? "The room is on a break; joining ends it."
      : "",
    reason === "old_join"
      ? `Rejoin needs one thing: restart the Konfab connector in ${NAME[app]}, then paste the rejoin prompt once.`
      : reason === "connected" || (connected && reason !== "unavailable")
        ? ""
        : ((reason && WHY[reason]) ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className="rejoin"
      role="group"
      aria-label={`Rejoin ${agent.display_name}`}
    >
      {text && <p role="status">{text}</p>}
      {hint && <p className="muted">{hint}</p>}
      {why && <p className="muted">{why}</p>}
      <div className="agent-return">
        {waiting && (
          <>
            {/* Codex's own button releases its queue, so nothing is pasted. */}
            <OpenApp
              roomId={roomId}
              agent={agent}
              copy={app === "claude" || !rejoin.can_open}
              primary={slow}
              act={act}
            />
            <button
              type="button"
              className="link"
              aria-disabled={busy}
              aria-describedby={help}
              title={CANCEL_HELP[app]}
              onClick={() => run(() => request(path, { method: "DELETE" }))}
            >
              Cancel
            </button>
            <span id={help} className="sr-only">
              {CANCEL_HELP[app]}
            </span>
          </>
        )}
        {(connected || open !== null) && (
          <>
            <button
              type="button"
              disabled={connected}
              className={connected ? "secondary" : ""}
              aria-disabled={busy || undefined}
              aria-describedby={help}
              title={connected ? WHY.connected : READY[app]}
              onClick={() => {
                if (open?.length) {
                  setAsking(true);
                  return;
                }
                if (rejoin.earlier && !window.confirm(EARLIER)) return;
                run(() =>
                  request(path, {
                    method: "POST",
                    body: { again: rejoin.earlier },
                  }),
                );
              }}
            >
              {open?.length ? openTitle(open) : "Rejoin"}
            </button>
            <span id={help} className="sr-only">
              {connected ? "" : READY[app]}
            </span>
          </>
        )}
        {copyable && (
          <OpenApp roomId={roomId} agent={agent} copy primary act={act} />
        )}
        {!connected && <JoinPrompts agent={agent} />}
      </div>
      {resting > 1 && rejoin.offer !== "watchers_full" && (
        <p className="muted">
          {resting} old watchers are resting; they end when Claude is closed.
        </p>
      )}
      {asking && (
        <RejoinQuestion
          room={room}
          agents={[agent]}
          act={act}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

type Results = {
  opened: ("pause" | "break")[];
  results: { agent_id: string; ok: boolean; error?: string }[];
};

/** Names everything that a click does, before it does it. */
function RejoinQuestion({
  room,
  agents,
  act,
  onClose,
}: {
  room: RoomNow;
  agents: Agent[];
  act: Act;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const ways = agents.map((agent) => ({
    agent,
    open: agent.rejoin ? toOpen(agent.rejoin, room) : null,
  }));
  const ready = ways.filter((way) => way.open !== null);
  const manual = ways.filter((way) => way.open === null);
  const open = ready[0]?.open ?? [];
  const earlier = ready.some(({ agent }) => agent.rejoin?.earlier);
  const title = openTitle(open);
  const send = (asked: Agent[]) => {
    if (busy) return;
    setBusy(true);
    void act(async () => {
      try {
        const done = await request<Results>(`/api/rooms/${room.id}/rejoin`, {
          method: "POST",
          body: {
            open,
            agents: asked.map((agent) => ({
              id: agent.id,
              again: agent.rejoin?.earlier ?? false,
            })),
          },
        });
        if (done.results.every((result) => result.ok) && !manual.length)
          onClose();
        else setResults(done);
      } catch (error) {
        // The page shows it, which this would hide.
        onClose();
        throw error;
      }
    }).finally(() => setBusy(false));
  };
  if (results)
    return (
      <Modal
        title={title}
        onClose={onClose}
        actions={
          <button type="button" onClick={onClose}>
            Close
          </button>
        }
      >
        <div role="status">
          {results.opened.map((part) => (
            <p key={part}>
              {part === "pause"
                ? "The room is resumed."
                : "The break has ended."}
            </p>
          ))}
          <ul>
            {results.results.map((result) => (
              <li key={result.agent_id}>
                <span>
                  {agents.find((agent) => agent.id === result.agent_id)
                    ?.display_name ?? result.agent_id}
                </span>
                <span>
                  {result.ok
                    ? "asked"
                    : `wasn't asked: ${result.error ?? "unknown"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Manual room={room} agents={manual.map((way) => way.agent)} act={act} />
      </Modal>
    );
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            {ready.length ? "Cancel" : "Close"}
          </button>
          {open.length > 0 && (
            <button
              type="button"
              className="secondary"
              aria-disabled={busy}
              onClick={() => send([])}
            >
              {open.length === 2
                ? "Only resume and end the break"
                : open[0] === "pause"
                  ? "Only resume"
                  : "Only end the break"}
            </button>
          )}
          {ready.length > 0 && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => send(ready.map((way) => way.agent))}
            >
              {busy
                ? "Asking…"
                : open.length
                  ? title
                  : earlier
                    ? "Send new prompts"
                    : "Rejoin"}
            </button>
          )}
        </>
      }
    >
      {ready.length > 0 && (
        <ul>
          {ready.map(({ agent }) => (
            <li key={agent.id}>
              <span>{agent.display_name}</span>
              <span>
                {appOf(agent.rejoin!) === "codex"
                  ? "Codex will be asked"
                  : "its watcher will be asked"}
                {agent.rejoin?.earlier ? ` · ${EARLIER_NOTE}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {open.length > 0 &&
          `This ${
            open.length === 2
              ? "resumes the whole room and ends its break"
              : open[0] === "pause"
                ? "resumes the whole room"
                : "ends the break of the whole room"
          }. ${
            room.queued.length
              ? `Queued turns can start: ${room.queued.join(", ")}. `
              : ""
          }`}
        {ready.length > 0 && "Experimental. It uses their allowance."}
      </p>
      <Manual room={room} agents={manual.map((way) => way.agent)} act={act} />
    </Modal>
  );
}

/** Those that need the lead, each with its one button. */
function Manual({
  room,
  agents,
  act,
}: {
  room: RoomNow;
  agents: Agent[];
  act: Act;
}) {
  if (!agents.length) return null;
  return (
    <>
      <p className="muted">These need you:</p>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id} className="by-hand">
            <span>{agent.display_name}</span>
            <OpenApp
              roomId={room.id}
              agent={agent}
              copy
              primary={false}
              act={act}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Whether the lead could bring it back, by this or by hand. */
function away(agent: Agent): boolean {
  const { rejoin } = agent;
  if (!rejoin || rejoin.request?.state === "waiting") return false;
  const offer = rejoin.then ?? rejoin.offer;
  if (offer === "connected" || offer === "elsewhere" || offer === "archived")
    return false;
  if (rejoin.request?.state === "joined" && offer !== "ready") return false;
  return isAway(agent) && rejoinShown(agent);
}

/** For a room: every agent that is away, after showing which. */
export function RejoinAgents({
  room,
  agents,
  act,
}: {
  room: RoomNow;
  agents: Agent[];
  act: Act;
}) {
  const [open, setOpen] = useState(false);
  const there = agents.filter(away);
  if (!open && !agents.some((agent) => agent.rejoin?.offer) && !there.length)
    return null;
  return (
    <>
      <button
        type="button"
        className="secondary rejoin-agents"
        disabled={!there.length}
        title={
          there.length
            ? "Experimental"
            : "Experimental. Available when an agent is away; its card says more."
        }
        onClick={() => setOpen(true)}
      >
        Rejoin agents
      </button>
      {open && (
        <RejoinQuestion
          room={room}
          agents={there}
          act={act}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
