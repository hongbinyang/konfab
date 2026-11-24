import { useState } from "react";
import type { RoomAgent } from "./api";

export type Unreachable = {
  agent_id: string;
  state: "not_responding" | "not_joined" | "window_ended";
  last_contact_at: number | null;
};

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function CopyPrompt({
  prompt,
  label,
  link = false,
}: {
  prompt: string;
  label: string;
  link?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={link ? "link" : "secondary"}
      onClick={() => {
        void navigator.clipboard.writeText(prompt).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * The short prompt brings back the conversation that already joined; a new
 * conversation needs the full join prompt with the loop and permission rule.
 */
export function RejoinPrompts({
  agent,
}: {
  agent: Pick<RoomAgent, "join_prompt" | "rejoin_prompt">;
}) {
  return (
    <span className="rejoin-prompts">
      <CopyPrompt prompt={agent.rejoin_prompt} label="Copy rejoin prompt" />{" "}
      <span className="muted">for the same conversation ·</span>{" "}
      <CopyPrompt prompt={agent.join_prompt} label="Copy full prompt" link />{" "}
      <span className="muted">for a new one</span>
    </span>
  );
}

/**
 * Shown on an agent card when Konfab has had no contact for longer than the
 * agent should take. It describes last contact rather than guessing a cause.
 */
export function ContactNotice({
  agent,
}: {
  agent: Pick<
    RoomAgent,
    | "state"
    | "working"
    | "stats"
    | "join_prompt"
    | "rejoin_prompt"
    | "turn_quiet_since"
  >;
}) {
  if (agent.state === "working" && agent.turn_quiet_since != null)
    return (
      <div className="contact-notice">
        <p className="warning-text">
          Working · no contact since {clock(agent.turn_quiet_since)}
        </p>
        <p className="muted">
          A long command may still be running. If its app shows it has stopped,
          paste the rejoin prompt into that app.
        </p>
        <RejoinPrompts agent={agent} />
      </div>
    );
  if (agent.state !== "not_responding") return null;
  const last = agent.stats.last_contact_at;
  const since = last === null ? "" : ` since ${clock(last)}`;
  return (
    <div className="contact-notice">
      <p className="warning-text">
        {agent.working ? `Working · no update${since}` : `No contact${since}`}
      </p>
      <p className="muted">
        Its conversation may have stopped. Paste the rejoin prompt into that app
        to bring it back.
      </p>
      <RejoinPrompts agent={agent} />
    </div>
  );
}

function reason(item: Unreachable): string {
  if (item.state === "not_joined") return "hasn't joined this room";
  if (item.state === "window_ended")
    return "has reached the end of its run window";
  return item.last_contact_at === null
    ? "isn't listening"
    : `has had no contact since ${clock(item.last_contact_at)}`;
}

/** Shown under the composer after the lead mentions agents that can't hear it. */
export function UnreachableNotice({
  items,
  agents,
  onDismiss,
}: {
  items: Unreachable[];
  agents: Array<
    Pick<RoomAgent, "id" | "display_name" | "join_prompt" | "rejoin_prompt">
  >;
  onDismiss: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="unreachable-notice" role="status">
      {items.map((item) => {
        const agent = agents.find(
          (candidate) => candidate.id === item.agent_id,
        );
        return (
          <p key={item.agent_id}>
            <strong>{agent?.display_name ?? item.agent_id}</strong>{" "}
            {reason(item)}, so your mention is waiting.{" "}
            {agent &&
              (item.state === "not_joined" ? (
                <CopyPrompt
                  prompt={agent.join_prompt}
                  label="Copy join prompt"
                />
              ) : (
                <RejoinPrompts agent={agent} />
              ))}
          </p>
        );
      })}
      <button type="button" className="secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
