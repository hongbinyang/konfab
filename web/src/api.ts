export type AgentState =
  | "not_joined"
  | "waiting"
  | "working"
  | "queued"
  | "waiting_approval"
  | "window_ended"
  | "on_break"
  | "not_responding";

export interface RoomSummary {
  id: number;
  name: string;
  topic: string;
  paused: boolean;
  on_break: boolean;
  archived: boolean;
  unread_count?: number;
  attention_count?: number;
}

export interface Permission {
  id: number;
  room_id: number;
  room: string;
  agent_id: string;
  recipient: string;
  data_description: string;
  reason: string;
  data_type: string | null;
  state: "pending" | "approved" | "denied";
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
  push_repository: string | null;
  push_branch: string | null;
  push_base: string | null;
  push_head: string | null;
}

export interface Report {
  id: number;
  room: string;
  agent_id: string;
  kind: "low_allowance" | "out_of_allowance" | "other";
  detail: string;
}

export interface RunWarning {
  id: number;
  threshold: number;
  created_at: number;
  session_id: string;
  room_id: number;
  agent_id: string;
  room: string;
}

export interface Overview {
  instance_id?: string;
  run_warnings?: RunWarning[];
  paused_all: boolean;
  rooms: RoomSummary[];
  agents: {
    id: string;
    display_name: string;
    app_id: string;
    app_name: string;
    is_default: number;
  }[];
  apps: { id: string; display_name: string; default_agent_id: string }[];
  max_agents_per_app: number;
  permissions: Permission[];
  reports: Report[];
  pre_approvals: { recipient: string; data: string }[];
}

export interface Attachment {
  id: string;
  filename: string;
  media_type: string;
  size: number;
  path: string;
}

export interface Message {
  id: number;
  sender_type: "user" | "agent" | "system";
  sender_id: string;
  body: string;
  created_at: number;
  attachments?: Attachment[];
  mentions?: string[];
  unread?: boolean;
}

export interface Pass {
  id: number;
  agent_id: string;
  reason: string | null;
  created_at: number;
}

export interface RoomAgent {
  id: string;
  /** In a room view: the room name if set, otherwise the display name. */
  display_name: string;
  /** The agent's own display name, used outside this room. */
  account_name?: string;
  /** The name the lead gave this agent in this room; it is also its mention. */
  room_name?: string | null;
  /** True once the agent has joined this room; the name can't change then. */
  name_fixed?: boolean;
  state: AgentState;
  turn_quiet_since?: number | null;
  bridge_outdated?: boolean;
  pending_mention_since?: number | null;
  working?: {
    detail: string;
    updated_at: number;
    stale_after_ms: number;
    stale: boolean;
  } | null;
  run_clock?: {
    remaining_ms: number;
    paused: boolean;
    server_now: number;
  } | null;
  saved_run_ms?: number | null;
  closes_at: number | null;
  join_prompt: string;
  assignment: {
    label: string;
    skill_count: number;
    instructions: string;
    revision: number;
    update_available: boolean;
  };
  can_edit: boolean;
  stats: {
    session_started_at: number | null;
    last_contact_at: number | null;
    longest_wait_ms: number | null;
    median_answer_ms: number | null;
    paused_turns: number;
    answer_samples: number;
    model_wait_calls: number;
    calls_per_hour: number | null;
    longest_gap_ms: number;
    rejoins: number;
    turns_completed: number;
    turns_skipped: number;
  };
}

export interface ActivityEvent {
  handoff?: { to: string; source_message_id: number };
  id: number;
  type: string;
  agent_id: string | null;
  created_at: number;
  last_contact_at: number | null;
}

export interface Decision {
  id: number;
  room_id: number;
  proposer: string;
  source_message_id: number | null;
  status: "proposed" | "confirmed" | "rejected" | "retired";
  body: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface LeadReadInfo {
  cursor: number;
  unread_count: number;
  attention_count: number;
  first_unread_id: number | null;
  older_unread_count: number;
}

export interface RoomState {
  routing?: {
    active: { agent_id: string; turn_id: number } | null;
    queued: {
      agent_id: string;
      turn_id: number;
      repair_source_message_id: number | null;
    }[];
    working: string[];
    auto_continue_enabled: boolean;
    automatic: {
      id: number;
      target_agent_id: string;
      reason: string;
      due_at: number;
      server_now: number;
      capped: boolean;
      blocked: string | null;
    } | null;
    suspended: boolean;
    no_continuation: boolean;
    eligible_agents: string[];
  };
  read_info?: LeadReadInfo;
  room: RoomSummary & {
    brief: string;
    project_path: string | null;
    parallel_lead_mentions: boolean;
    checkin_minutes: number | null;
    checkin_default: number;
    agent_streak: number;
    streak_limit: number;
  };
  agents: RoomAgent[];
  /** Room names by agent ID, including former members. */
  room_names?: Record<string, string>;
  queued: string[];
  format: null | {
    id: number;
    kind: "review" | "debate";
    topic: string;
    rounds: number;
    state: "active" | "paused";
    current_step: number;
    step_count: number;
    step: null | { agent_id: string; slot: string; round: number };
  };
  locks: Array<{
    resource: string;
    agent_id: string;
    purpose: string;
    acquired_at: number;
    expires_at: number;
  }>;
  messages: Message[];
  passes?: Pass[];
  activity: ActivityEvent[];
  permissions: Permission[];
  decisions: Decision[];
}

export class UnauthorizedError extends Error {}

/** A failed request, with the server's error code and any extra fields. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    ...(options.body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  if (response.status === 401) throw new UnauthorizedError("Sign in required");
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    const details = payload as unknown as Record<string, unknown>;
    throw new RequestError(
      payload.message ?? "Request failed",
      typeof details.code === "string" ? details.code : undefined,
      details,
    );
  }
  return payload;
}

export async function uploadAttachment(
  roomId: number,
  file: File,
): Promise<Attachment> {
  const response = await fetch(
    `/api/rooms/${roomId}/attachments?name=${encodeURIComponent(file.name || "clipboard-image")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    },
  );
  if (response.status === 401) throw new UnauthorizedError("Sign in required");
  const payload = (await response.json()) as Attachment & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? "Upload failed");
  return payload;
}

/** The mention an agent answers to in a room: its room name, else its ID. */
export function mentionName(agent: Pick<RoomAgent, "id" | "room_name">) {
  return agent.room_name ?? agent.id;
}

/** Show each member by its room name everywhere inside the room view. */
export function withRoomLabels<
  T extends { agents: RoomAgent[]; room_names?: Record<string, string> },
>(state: T): T {
  return {
    ...state,
    agents: state.agents.map((agent) => ({
      ...agent,
      account_name: agent.display_name,
      display_name: agent.room_name ?? agent.display_name,
    })),
  };
}
