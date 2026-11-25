import { useEffect, useRef, useState } from "react";
import { RejoinPrompts } from "./ContactNotice";
import { request, type RejoinState, type RoomAgent } from "./api";

type Act = (action: () => Promise<unknown>) => Promise<void>;
type Agent = Pick<
  RoomAgent,
  "id" | "display_name" | "state" | "rejoin" | "join_prompt" | "rejoin_prompt"
>;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const EARLIER =
  "Another prompt may already be waiting there. Send a new one? Only the newest can rejoin.";
export const CANCEL_HELP = {
  codex:
    "Cancel closes Konfab's request. It can't take back the prompt in Codex: that may still start a short turn, which will be told to end.",
  claude:
    "Cancel closes Konfab's request. It can't take back the wake-up: that may still start a short turn, which will be told to end.",
};
const NAME = { codex: "Codex", claude: "Claude" };
const appOf = (rejoin: RejoinState) => rejoin.app ?? "codex";

const OFFER: Record<string, string> = {
  connected: "Available when the agent is away.",
  no_watcher: "Its watcher isn't running. Use the rejoin prompt.",
  unavailable: "The Codex command can't be used; npm run doctor says why.",
  elsewhere: "Its conversation is in another room now.",
  archived: "The room is archived.",
  paused: "The room is paused.",
  on_break: "The room is on a break.",
};

/** What has become of the lead's request, in words. */
export function rejoinText(rejoin: RejoinState): string | null {
  const asked = rejoin.request;
  if (!asked) return null;
  const app = appOf(rejoin);
  if (asked.state === "closed")
    return app === "claude"
      ? asked.refused
        ? "Its watcher didn't take it; nothing was sent. Use the rejoin prompt."
        : "Rejoin closed. A wake-up may still come; it can start a short turn, but can't rejoin."
      : asked.refused
        ? "Codex didn't take it; nothing is waiting there. Use the rejoin prompt."
        : "Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.";
  if (asked.state === "joined")
    return asked.slow
      ? `Joined, but not waiting yet. Look at its conversation in ${NAME[app]}, or paste the rejoin prompt.`
      : "Joined · waiting for its first check.";
  const time = clock(asked.asked_at);
  const sent = asked.unsure
    ? `Rejoin asked ${time} · Konfab couldn't tell whether ${app === "codex" ? "Codex" : "its watcher"} took it.`
    : `Rejoin asked ${time} · waiting.`;
  if (asked.slow && app === "claude")
    return `${sent} Not back yet. If you pressed Stop, paste the rejoin prompt. Otherwise look at its conversation in Claude: it may ask you something or have reached a limit.`;
  return asked.slow
    ? `${sent} Not back yet. Open its conversation in Codex. If it was stopped with Stop, the prompt waits there until its next turn ends. You can paste the rejoin prompt instead; the earlier prompt then stays in Codex and may start one short turn later.`
    : sent;
}

/** On an agent's card. The manual prompts are there in every state. */
export function RejoinControls({
  roomId,
  agent,
  act,
}: {
  roomId: number;
  agent: Agent;
  act: Act;
}) {
  const { rejoin } = agent;
  const [busy, setBusy] = useState(false);
  const path = `/api/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/rejoin`;
  if (!rejoin || (!rejoin.offer && !rejoin.request)) return null;
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void act(action).finally(() => setBusy(false));
  };
  const text = rejoinText(rejoin);
  const app = appOf(rejoin);
  const resting = rejoin.resting ?? 0;
  const why =
    rejoin.offer === "old_join"
      ? `Not yet: restart the Konfab connector in ${NAME[app]}, then paste the rejoin prompt once.`
      : rejoin.offer === "watchers_full"
        ? "Too many old watchers may still be running, so no new one is started. Closing Claude normally ends them; restarting the computer always does."
        : OFFER[rejoin.offer ?? ""];
  const waiting = rejoin.request?.state === "waiting";
  return (
    <div
      className="rejoin"
      role="group"
      aria-label={`Rejoin ${agent.display_name}`}
    >
      {text && <p role="status">{text}</p>}
      {waiting && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => run(() => request(path, { method: "DELETE" }))}
          >
            Cancel
          </button>
          <p className="muted">{CANCEL_HELP[app]}</p>
        </>
      )}
      {rejoin.offer && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={busy || rejoin.offer !== "ready"}
            onClick={() => {
              if (rejoin.earlier && !window.confirm(EARLIER)) return;
              run(() =>
                request(path, {
                  method: "POST",
                  body: { again: rejoin.earlier },
                }),
              );
            }}
          >
            Rejoin
          </button>{" "}
          <span className="muted">
            Experimental ·{" "}
            {rejoin.offer === "ready"
              ? app === "codex"
                ? "asks Codex to bring its conversation back; uses its allowance"
                : "wakes its conversation in Claude; uses its allowance. Not after Stop"
              : why}
          </span>
        </>
      )}
      {resting > 1 && rejoin.offer !== "watchers_full" && (
        <p className="muted">
          {resting} old watchers are resting; they end when Claude is closed.
        </p>
      )}
      {/* Beside the contact notice, which has them, they'd be there twice. */}
      {agent.state !== "not_responding" && rejoin.offer !== "connected" && (
        <p>
          <RejoinPrompts agent={agent} />
        </p>
      )}
    </div>
  );
}

/** For a room: every agent it is offered for, after showing which. */
export function RejoinAgents({
  roomId,
  agents,
  act,
}: {
  roomId: number;
  agents: Agent[];
  act: Act;
}) {
  const ready = agents.filter((agent) => agent.rejoin?.offer === "ready");
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [open]);
  if (!open && !agents.some((agent) => agent.rejoin?.offer)) return null;
  const earlier = ready.some((agent) => agent.rejoin?.earlier);
  return (
    <>
      <button
        type="button"
        className="secondary rejoin-agents"
        disabled={!ready.length}
        title={
          ready.length
            ? "Experimental"
            : "Experimental. Available when an agent is away; its card says more."
        }
        onClick={() => setOpen(true)}
      >
        Rejoin agents
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="message-review"
          aria-labelledby="rejoin-agents-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
          }}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <h2 id="rejoin-agents-title">Rejoin agents (experimental)</h2>
          <p>
            Konfab asks their apps to bring these back in the conversations they
            last joined from. It uses their allowance.
          </p>
          <ul>
            {ready.map((agent) => (
              <li key={agent.id}>
                {agent.display_name}
                {agent.rejoin?.earlier ? ` · ${EARLIER}` : ""}
              </li>
            ))}
          </ul>
          <div className="message-review-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!ready.length}
              onClick={() => {
                setOpen(false);
                void act(async () => {
                  const results = await Promise.allSettled(
                    ready.map((agent) =>
                      request(
                        `/api/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/rejoin`,
                        {
                          method: "POST",
                          body: { again: agent.rejoin?.earlier ?? false },
                        },
                      ),
                    ),
                  );
                  const failed = results.find(
                    (result) => result.status === "rejected",
                  );
                  if (failed) throw failed.reason;
                });
              }}
            >
              {earlier ? "Send new prompts" : "Rejoin"}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
