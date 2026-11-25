import { useState } from "react";
import { RejoinPrompts } from "./ContactNotice";
import { request, type RoomAgent, type StopState } from "./api";

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
}: {
  roomId: number;
  agent: Pick<
    RoomAgent,
    "id" | "display_name" | "stop" | "join_prompt" | "rejoin_prompt"
  >;
  act: Act;
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
      {stop.state && stop.state !== "asked" && <RejoinPrompts agent={agent} />}
    </div>
  );
}
