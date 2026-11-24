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
export const CANCEL_HELP =
  "Cancel closes Konfab's request. It can't take back the prompt in Codex: that may still start a short turn, which will be told to end.";

const OFFER: Record<string, string> = {
  elsewhere: "Its conversation is in another room now.",
  archived: "The room is archived.",
  paused: "The room is paused.",
  on_break: "The room is on a break.",
};

/** What has become of the lead's request, in words. */
export function rejoinText(rejoin: RejoinState): string | null {
  const asked = rejoin.request;
  if (!asked) return null;
  if (asked.state === "closed")
    return asked.refused
      ? "Codex didn't take it; nothing is waiting there. Use the rejoin prompt."
      : "Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.";
  if (asked.state === "joined")
    return asked.slow
      ? "Joined, but not waiting yet. Look at its conversation in Codex, or paste the rejoin prompt."
      : "Joined · waiting for its first check.";
  const time = clock(asked.asked_at);
  const sent = asked.unsure
    ? `Rejoin asked ${time} · Konfab couldn't tell whether Codex took it.`
    : `Rejoin asked ${time} · waiting.`;
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
          <p className="muted">{CANCEL_HELP}</p>
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
              ? "asks Codex to bring its conversation back; uses its allowance"
              : OFFER[rejoin.offer]}
          </span>
        </>
      )}
      {/* Beside the contact notice, which has them, they'd be there twice. */}
      {agent.state !== "not_responding" && (
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
  if (!ready.length && !open) return null;
  const earlier = ready.some((agent) => agent.rejoin?.earlier);
  return (
    <>
      <button
        type="button"
        className="secondary"
        title="Experimental"
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
            Konfab asks Codex to bring these back in the conversations they last
            joined from. It uses their allowance.
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
