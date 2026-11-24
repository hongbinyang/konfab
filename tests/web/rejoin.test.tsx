// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RejoinState } from "../../web/src/api";
import {
  CANCEL_HELP,
  EARLIER,
  RejoinAgents,
  RejoinControls,
  rejoinText,
} from "../../web/src/Rejoin";

const at = new Date(2026, 10, 23, 12, 3).getTime();
const time = new Date(at).toLocaleTimeString([], {
  hour: "numeric",
  minute: "2-digit",
});
type Asked = NonNullable<RejoinState["request"]>;
const asked = (overrides: Partial<Asked> = {}): Asked => ({
  state: "waiting",
  unsure: false,
  refused: false,
  slow: false,
  asked_at: at,
  ...overrides,
});
const rejoin = (overrides: Partial<RejoinState> = {}): RejoinState => ({
  offer: null,
  request: null,
  earlier: false,
  ...overrides,
});
const agent = (
  state: RejoinState | undefined,
  overrides: object = {},
): Parameters<typeof RejoinControls>[0]["agent"] => ({
  id: "codex",
  display_name: "Codex",
  state: "not_responding",
  rejoin: state,
  join_prompt: "Join Konfab room konfab",
  rejoin_prompt: "Rejoin Konfab room konfab",
  ...overrides,
});

describe("asking an agent to rejoin", () => {
  let calls: { url: string; method: string; body: unknown }[];
  const act = async (action: () => Promise<unknown>) => {
    await action();
  };
  const card = (state: RejoinState | undefined, overrides: object = {}) =>
    render(
      <RejoinControls roomId={4} agent={agent(state, overrides)} act={act} />,
    );

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [asked(), `Rejoin asked ${time} · waiting.`],
    [
      asked({ unsure: true }),
      `Rejoin asked ${time} · Konfab couldn't tell whether Codex took it.`,
    ],
    [
      asked({ slow: true }),
      `Rejoin asked ${time} · waiting. Not back yet. Open its conversation in Codex. If it was stopped with Stop, the prompt waits there until its next turn ends. You can paste the rejoin prompt instead; the earlier prompt then stays in Codex and may start one short turn later.`,
    ],
    [
      asked({ state: "closed" }),
      "Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.",
    ],
    [
      asked({ state: "closed", refused: true }),
      "Codex didn't take it; nothing is waiting there. Use the rejoin prompt.",
    ],
    [asked({ state: "joined" }), "Joined · waiting for its first check."],
    [
      asked({ state: "joined", slow: true }),
      "Joined, but not waiting yet. Look at its conversation in Codex, or paste the rejoin prompt.",
    ],
  ])("says what became of it (%#)", (request, text) => {
    expect(rejoinText(rejoin({ request }))).toBe(text);
    card(rejoin({ request }), { state: "waiting" });
    expect(screen.getByRole("status").textContent).toBe(text);
    // The manual prompts are there in every state.
    expect(
      screen.getByRole("button", { name: "Copy rejoin prompt" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy full prompt" }),
    ).toBeTruthy();
    const waiting = request.state === "waiting";
    expect(screen.queryByRole("button", { name: "Cancel" }) !== null).toBe(
      waiting,
    );
    expect(screen.queryByText(CANCEL_HELP) !== null).toBe(waiting);
  });

  it("shows nothing where it isn't offered, also with an older server", () => {
    expect(card(rejoin()).container.textContent).toBe("");
    expect(card(undefined).container.textContent).toBe("");
  });

  it("asks once, with the keyboard", async () => {
    card(rejoin({ offer: "ready" }));
    expect(screen.getByText(/Experimental/)).toBeTruthy();
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Rejoin");
    await userEvent.keyboard("{Enter}");
    expect(calls).toEqual([
      {
        url: "/api/rooms/4/agents/codex/rejoin",
        method: "POST",
        body: { again: false },
      },
    ]);
  });

  it.each([
    ["elsewhere", "Its conversation is in another room now."],
    ["archived", "The room is archived."],
    ["paused", "The room is paused."],
    ["on_break", "The room is on a break."],
  ] as const)("is disabled and says why: %s", async (offer, text) => {
    card(rejoin({ offer }));
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rejoin",
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(new RegExp(text))).toBeTruthy();
    await userEvent.click(button);
    expect(calls).toEqual([]);
  });

  it("asks before sending a second prompt", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    card(
      rejoin({
        offer: "ready",
        earlier: true,
        request: asked({ state: "closed" }),
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    expect(confirm).toHaveBeenCalledWith(EARLIER);
    expect(calls).toEqual([]);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    expect(calls[0]).toMatchObject({ method: "POST", body: { again: true } });
  });

  it("cancels, saying that the prompt in Codex stays", async () => {
    card(rejoin({ request: asked() }));
    expect(CANCEL_HELP).toContain("can't take back the prompt in Codex");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([
      {
        url: "/api/rooms/4/agents/codex/rejoin",
        method: "DELETE",
        body: null,
      },
    ]);
  });

  it("asks all agents it is ready for, after showing which", async () => {
    render(
      <RejoinAgents
        roomId={4}
        agents={[
          agent(rejoin({ offer: "ready" })),
          agent(rejoin({ offer: "ready", earlier: true }), {
            id: "codex2",
            display_name: "Second",
          }),
          agent(rejoin({ offer: "elsewhere" }), {
            id: "third",
            display_name: "Third",
          }),
          agent(rejoin(), { id: "claude", display_name: "Claude" }),
        ]}
        act={act}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Codex", `Second · ${EARLIER}`]);
    expect(dialog.textContent).toContain("experimental");
    expect(dialog.textContent).toContain("uses their allowance");
    expect(calls).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual([]);
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send new prompts" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      ["/api/rooms/4/agents/codex/rejoin", { again: false }],
      ["/api/rooms/4/agents/codex2/rejoin", { again: true }],
    ]);
  });

  it("has no room button when nobody can be asked", () => {
    const { container } = render(
      <RejoinAgents roomId={4} agents={[agent(rejoin())]} act={act} />,
    );
    expect(container.textContent).toBe("");
  });
});
