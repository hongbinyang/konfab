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

export interface Overview {
  paused_all: boolean;
  rooms: RoomSummary[];
  agents: { id: string; display_name: string }[];
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
  sender_type: "user" | "agent";
  sender_id: string;
  body: string;
  created_at: number;
  attachments?: Attachment[];
  mentions?: string[];
}

export interface Pass {
  id: number;
  agent_id: string;
  reason: string | null;
  created_at: number;
}

export interface RoomAgent {
  id: string;
  display_name: string;
  state: AgentState;
  bridge_outdated?: boolean;
  closes_at: number | null;
  join_prompt: string;
  role: string;
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

export interface RoomState {
  room: RoomSummary & {
    brief: string;
    agent_streak: number;
    streak_limit: number;
  };
  agents: RoomAgent[];
  queued: string[];
  messages: Message[];
  passes?: Pass[];
  activity: ActivityEvent[];
  permissions: Permission[];
  decisions: Decision[];
}

export class UnauthorizedError extends Error {}

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
  if (!response.ok) throw new Error(payload.message ?? "Request failed");
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
