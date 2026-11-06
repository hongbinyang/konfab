export type AgentState =
  | "not_joined"
  | "waiting"
  | "working"
  | "outside_hours"
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
  room: string;
  agent_id: string;
  recipient: string;
  data_description: string;
  reason: string;
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

export interface Message {
  id: number;
  sender_type: "user" | "agent";
  sender_id: string;
  body: string;
  created_at: number;
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
  hours: { start: string; end: string; days: string[] } | null;
  next_start: number | null;
  closes_at: number | null;
  join_prompt: string;
  stats: {
    model_wait_calls: number;
    calls_per_hour: number | null;
    longest_gap_ms: number;
    rejoins: number;
    turns_completed: number;
    turns_skipped: number;
  };
}

export interface RoomState {
  room: RoomSummary & { agent_streak: number; streak_limit: number };
  agents: RoomAgent[];
  queued: string[];
  messages: Message[];
  passes?: Pass[];
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
