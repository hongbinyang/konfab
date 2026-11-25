// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StopState } from "../../web/src/api";
import { UnreachableNotice } from "../../web/src/ContactNotice";
import {
  RECEIVED_HELP,
  REPLACE_WARNING,
  StopControls,
  stopHelp,
} from "../../web/src/Stop";

const at = new Date(2026, 10, 24, 18, 40).getTime();
const clock = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
const T = clock(at);
const L = clock(at + 120_000);
const stop = (overrides: Partial<StopState> = {}): StopState => ({
  can: null,
  state: null,
  after: null,
  asked_at: at,
  quiet_since: null,
  long_ago: false,
  called_at: null,
  joined_again_at: null,
  holds_lock: false,
  open_permission: false,
  ...overrides,
});
const agent = (state: StopState | undefined) => ({
  id: "codex",
  display_name: "Codex",
  stop: state,
  join_prompt: "Join",
  rejoin_prompt: "Rejoin",
});

describe("stopping an agent on its card", () => {
  let calls: string[];
  const act = async (action: () => Promise<unknown>) => {
    await action();
  };
  const card = (state: StopState | undefined) =>
    render(<StopControls roomId={4} agent={agent(state)} act={act} />);

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ["now", "Stop agent", "in this room; work already running"],
    ["after_turn", "Stop after turn", "after its current turn; work"],
    ["after_work", "Stop after this work", "after its current work; work"],
  ] as const)(
    "offers it as it would work, with its help, by keyboard: %s",
    async (can, label, help) => {
      card(stop({ can }));
      const button = screen.getByRole("button", { name: label });
      expect(button.title).toContain(help);
      expect(button.title).toContain("isn't the app's own Stop button");
      const described = document.getElementById(
        button.getAttribute("aria-describedby")!,
      );
      expect(described?.textContent).toBe(button.title);
      expect(button.title).not.toContain("lock");
      await userEvent.tab();
      await userEvent.keyboard("{Enter}");
      expect(calls).toEqual(["POST /api/rooms/4/agents/codex/stop"]);
    },
  );

  it("says that a lock is released", () => {
    expect(stopHelp(stop({ can: "now", holds_lock: true }))).toContain(
      "It holds a lock, which is released when its session ends.",
    );
  });

  it("shows nothing for an agent that isn't there, or with an older server", () => {
    expect(card(stop()).container.textContent).toBe("");
    expect(card(undefined).container.textContent).toBe("");
  });

  it.each([
    [stop({ state: "asked", after: "turn" }), "Stopping after this turn."],
    [stop({ state: "asked", after: "work" }), "Stopping after this work."],
    [
      stop({ state: "asked", after: "turn", quiet_since: at - 120_000 }),
      `Stop asked ${T}, but no call since ${clock(at - 120_000)}. It may be working, hang, or have ended. Look in its app.`,
    ],
    [stop({ state: "answered" }), `Stop sent ${T}. Not confirmed.`],
    [
      stop({ state: "received" }),
      `Stopped ${T}. Its app may take a moment to end its turn.`,
    ],
    [
      stop({ state: "undelivered" }),
      "Stop not delivered yet. It is told at its next call.",
    ],
    [
      stop({ state: "undelivered", long_ago: true }),
      "Stop not delivered yet. It is told at its next call. It may have ended already. Look in its app.",
    ],
    [
      stop({ state: "received", called_at: at + 120_000 }),
      `Stopped ${T}, but it called again at ${L}. Its calls are refused. Look in its app.`,
    ],
    [
      stop({ state: "answered", called_at: at + 120_000 }),
      `Stop sent ${T}, but it called again at ${L}. Its calls are refused. Look in its app.`,
    ],
    [
      stop({ can: "now", joined_again_at: at }),
      `It joined again at ${T}. Your Stop no longer applies.`,
    ],
    [
      stop({ state: "asked", after: "work", open_permission: true }),
      "Stopping after this work. A permission it asked for is open; an answer may go unused.",
    ],
  ])("says what became of it (%#)", (state, text) => {
    card(state);
    expect(screen.getByRole("status").textContent).toBe(text);
    const asked = state.state === "asked";
    expect(
      screen.queryByRole("button", { name: "Keep in room" }) !== null,
    ).toBe(asked);
    // "Stopped" is only said of one whose connector has it, with what it means.
    expect(text.startsWith("Stopped")).toBe(state.state === "received");
    expect(screen.queryByText(RECEIVED_HELP) !== null).toBe(
      state.state === "received",
    );
    // The prompt: once it has ended, or with a warning when nothing is heard.
    const prompt =
      (state.state !== null && !asked) || (asked && state.quiet_since !== null);
    expect(
      screen.queryByRole("button", { name: "Copy rejoin prompt" }) !== null,
    ).toBe(prompt);
    expect(screen.queryByText(REPLACE_WARNING) !== null).toBe(
      asked && state.quiet_since !== null,
    );
    for (const word of ["allowance", "the model", "lead asked"])
      expect(text).not.toContain(word);
  });

  it("is undone, and the focus stays on the one button", async () => {
    const view = card(stop({ can: "after_turn" }));
    const button = screen.getByRole("button", { name: "Stop after turn" });
    await userEvent.click(button);
    view.rerender(
      <StopControls
        roomId={4}
        agent={agent(stop({ state: "asked", after: "turn" }))}
        act={act}
      />,
    );
    const keep = screen.getByRole("button", { name: "Keep in room" });
    expect(keep).toBe(button);
    expect(document.activeElement).toBe(keep);
    await userEvent.keyboard("{Enter}");
    expect(calls).toEqual([
      "POST /api/rooms/4/agents/codex/stop",
      "DELETE /api/rooms/4/agents/codex/stop",
    ]);
  });

  it("is named in the note under the message box", () => {
    render(
      <UnreachableNotice
        items={[{ agent_id: "codex", state: "stopped", last_contact_at: at }]}
        agents={[
          {
            id: "codex",
            display_name: "Codex",
            join_prompt: "Join",
            rejoin_prompt: "Rejoin",
          },
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Codex is stopped, so your mention is waiting.",
    );
  });
});
