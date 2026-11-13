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

function CopyPrompt({ prompt, label }: { prompt: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
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
 * Shown on an agent card when Konfab has had no contact for longer than the
 * agent should take. It describes last contact rather than guessing a cause.
 */
export function ContactNotice({
  agent,
}: {
  agent: Pick<RoomAgent, "state" | "working" | "stats" | "join_prompt">;
}) {
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
      <CopyPrompt prompt={agent.join_prompt} label="Copy rejoin prompt" />
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
  agents: Array<Pick<RoomAgent, "id" | "display_name" | "join_prompt">>;
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
            {agent && (
              <CopyPrompt
                prompt={agent.join_prompt}
                label={
                  item.state === "not_joined"
                    ? "Copy join prompt"
                    : "Copy rejoin prompt"
                }
              />
            )}
          </p>
        );
      })}
      <button type="button" className="secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
