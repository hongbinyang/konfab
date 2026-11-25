import { useState } from "react";
import { JoinPrompts, RejoinPrompts } from "./ContactNotice";
import { Modal } from "./Modal";
import { request, type RoomAgent, type StopState } from "./api";

type Agent = Pick<
  RoomAgent,
  "id" | "display_name" | "stop" | "join_prompt" | "rejoin_prompt"
>;
type Act = (action: () => Promise<unknown>) => Promise<void>;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const LABEL = {
  now: "Stop agent",
  after_turn: "Stop after turn",
  after_work: "Stop after this work",
};

export function stopHelp(stop: StopState): string {
  return [
    stop.can === "now"
      ? "Stops this agent in this room; work already running in its app is not interrupted."
      : `Stops this agent in this room after its current ${stop.can === "after_work" ? "work" : "turn"}; work already running in its app is not interrupted.`,
    "This isn't the app's own Stop button.",
    ...(stop.holds_lock
      ? ["It holds a lock, which is released when its session ends."]
      : []),
  ].join(" ");
}

export const RECEIVED_HELP =
  "Its connector has the stop. Konfab can't see whether its app has stopped.";
export const REPLACE_WARNING =
  "Pasting the rejoin prompt replaces the session: a lock it holds is released, and a running turn is queued again.";

/** What has become of the lead's stop, in words. */
export function stopText(stop: StopState): string | null {
  const at = clock(stop.asked_at ?? 0);
  const again =
    stop.called_at === null
      ? ""
      : `, but it called again at ${clock(stop.called_at)}. Its calls are refused. Look in its app.`;
  const permission = stop.open_permission
    ? " A permission it asked for is open; an answer may go unused."
    : "";
  switch (stop.state) {
    case "asked":
      return (
        (stop.quiet_since === null
          ? `Stopping after this ${stop.after ?? "turn"}.`
          : `Stop asked ${at}, but no call since ${clock(stop.quiet_since)}. It may be working, hang, or have ended. Look in its app.`) +
        permission
      );
    case "received":
      return (
        (again
          ? `Stopped ${at}${again}`
          : `Stopped ${at}. Its app may take a moment to end its turn.`) +
        permission
      );
    case "answered":
      return (
        (again
          ? `Stop sent ${at}${again}`
          : `Stop sent ${at}. Not confirmed.`) + permission
      );
    case "undelivered":
      return (
        "Stop not delivered yet. It is told at its next call." +
        (stop.long_ago ? " It may have ended already. Look in its app." : "") +
        permission
      );
    default:
      return stop.joined_again_at === null
        ? null
        : `It joined again at ${clock(stop.joined_again_at)}. Your Stop no longer applies.`;
  }
}

/** On an agent's card. */
export function StopControls({
  roomId,
  agent,
  act,
  prompts = true,
}: {
  roomId: number;
  agent: Agent;
  act: Act;
  /** Other controls on the card have them otherwise. */
  prompts?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { stop } = agent;
  if (!stop) return null;
  const text = stopText(stop);
  if (!text && !stop.can) return null;
  const path = `/api/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/stop`;
  const send = (method: "POST" | "DELETE") => {
    if (busy) return;
    setBusy(true);
    void act(() => request(path, { method })).finally(() => setBusy(false));
  };
  const help = stop.can ? stopHelp(stop) : "";
  const helpId = `stop-help-${agent.id}`;
  return (
    <div
      className="stop-agent"
      role="group"
      aria-label={`Stop ${agent.display_name}`}
    >
      {text && (
        <p
          role="status"
          title={stop.state === "received" ? RECEIVED_HELP : undefined}
        >
          {text}
        </p>
      )}
      {/* One place for both, so that the focus stays when one follows the other. */}
      {(stop.state === "asked" || stop.can) && (
        <button
          type="button"
          className="secondary"
          // Not `disabled`, which would lose the focus.
          aria-disabled={busy}
          aria-describedby={stop.can ? helpId : undefined}
          title={help || undefined}
          onClick={() => send(stop.can ? "POST" : "DELETE")}
        >
          {stop.can ? LABEL[stop.can] : "Keep in room"}
        </button>
      )}
      {stop.can && (
        <span id={helpId} className="sr-only">
          {help}
        </span>
      )}
      {stop.state === "received" && <p className="muted">{RECEIVED_HELP}</p>}
      {stop.state === "asked" && stop.quiet_since !== null && (
        <>
          <p className="muted">{REPLACE_WARNING}</p>
          <RejoinPrompts agent={agent} />
        </>
      )}
      {prompts && stop.state && stop.state !== "asked" && (
        <JoinPrompts agent={agent} />
      )}
    </div>
  );
}

const PLAN = {
  now: "will be asked now",
  after_turn: "in a turn · will be asked after it",
  after_work: "working · will be asked after it",
};
const RESULT = {
  ended: "its session in Konfab has ended",
  after_turn: "asked after its turn",
  after_work: "asked after its work",
  not_there: "not there to be stopped",
  failed: "couldn't be asked; look at its card",
};
type Result = { agent_id: string; result: keyof typeof RESULT };

/** Agents that are there, or asked already. */
const stoppable = (agents: Agent[]) =>
  agents.filter((agent) => agent.stop?.can || agent.stop?.state === "asked");

/** For a room: all agents that are there, after showing what each is told. */
export function StopAgents({
  roomId,
  agents,
  act,
  open,
  onOpen,
  onClose,
}: {
  roomId: number;
  agents: Agent[];
  act: Act;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  if (!agents.some((agent) => agent.stop)) return null;
  const there = stoppable(agents);
  const close = () => {
    setResults(null);
    onClose();
  };
  const name = (id: string) =>
    agents.find((agent) => agent.id === id)?.display_name ?? id;
  const send = () => {
    if (busy) return;
    setBusy(true);
    void act(async () => {
      try {
        const done = await request<{ results: Result[] }>(
          `/api/rooms/${roomId}/stop-agents`,
          { method: "POST", body: { agents: there.map((agent) => agent.id) } },
        );
        if (
          done.results.some((item) =>
            ["not_there", "failed"].includes(item.result),
          )
        )
          setResults(done.results);
        else close();
      } catch (error) {
        // The page shows it, which this would hide.
        close();
        throw error;
      }
    }).finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        className="secondary stop-agents"
        disabled={!there.length}
        title={
          there.length
            ? "Asks the agents to leave the room, each at the right moment"
            : "Available when an agent is there"
        }
        onClick={onOpen}
      >
        Stop agents
      </button>
      {open && (
        <Modal
          title="Stop agents"
          onClose={close}
          actions={
            results ? (
              <button type="button" onClick={close}>
                Close
              </button>
            ) : (
              <>
                <button type="button" className="secondary" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!there.length}
                  aria-disabled={busy}
                  onClick={send}
                >
                  Stop agents
                </button>
              </>
            )
          }
        >
          <ul role={results ? "status" : undefined}>
            {results
              ? results.map((item) => (
                  <li key={item.agent_id}>
                    <span>{name(item.agent_id)}</span>
                    <span>{RESULT[item.result]}</span>
                  </li>
                ))
              : agents.map((agent) => (
                  <li key={agent.id}>
                    <span>{agent.display_name}</span>
                    <span>
                      {agent.stop?.can
                        ? PLAN[agent.stop.can]
                        : agent.stop?.state === "asked"
                          ? "asked already"
                          : "not there"}
                      {agent.stop?.can && agent.stop.holds_lock
                        ? " · holds a lock, which is released"
                        : ""}
                    </span>
                  </li>
                ))}
          </ul>
          {!results && (
            <p className="muted">
              They are asked to leave the room. Work already running in their
              apps isn&apos;t interrupted, and Konfab can&apos;t see whether an
              app has stopped.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

/** Only what is known of each, counted. Never "done" or "safe". */
export function stopCounts(stops: (StopState | undefined)[]): string | null {
  const words = stops.flatMap((stop) =>
    !stop?.state
      ? []
      : stop.called_at !== null
        ? ["called again"]
        : stop.state === "asked"
          ? [`after its ${stop.after ?? "turn"}`]
          : stop.state === "received"
            ? ["connector has it"]
            : stop.state === "answered"
              ? ["sent, not confirmed"]
              : ["not delivered"],
  );
  if (!words.length) return null;
  return `Stop: ${[...new Set(words)]
    .map((word) => `${words.filter((item) => item === word).length} ${word}`)
    .join(" · ")}`;
}

/** In the header, while a stop is asked or stands. */
export function StopSummary({
  roomId,
  agents,
  act,
}: {
  roomId: number;
  agents: Agent[];
  act: Act;
}) {
  const [busy, setBusy] = useState(false);
  const text = stopCounts(agents.map((agent) => agent.stop));
  const asked = agents.filter((agent) => agent.stop?.state === "asked");
  if (!text) return null;
  return (
    <p className="stop-summary">
      <span role="status">{text}</span>
      {asked.length > 0 && (
        <button
          type="button"
          className="link"
          aria-disabled={busy}
          title="Undoes the stop of those that haven't ended"
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void act(() =>
              request(`/api/rooms/${roomId}/keep-agents`, {
                method: "POST",
                body: { agents: asked.map((agent) => agent.id) },
              }),
            ).finally(() => setBusy(false));
          }}
        >
          Keep all
        </button>
      )}
    </p>
  );
}
