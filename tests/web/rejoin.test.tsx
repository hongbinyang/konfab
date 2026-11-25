// @vitest-environment jsdom
import {
  act as actNow,
  cleanup,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RejoinState } from "../../web/src/api";
import {
  CANCEL_HELP,
  EARLIER,
  EARLIER_NOTE,
  PASTE_WARNING,
  RejoinAgents,
  RejoinControls,
  rejoinHint,
  rejoinText,
  type RoomNow,
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
const room = (overrides: Partial<RoomNow> = {}): RoomNow => ({
  id: 4,
  paused: false,
  on_break: false,
  queued: [],
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
  const card = (
    state: RejoinState | undefined,
    overrides: object = {},
    now: RoomNow = room(),
  ) =>
    render(
      <RejoinControls room={now} agent={agent(state, overrides)} act={act} />,
    );
  let answer: (url: string) => object;

  beforeEach(() => {
    calls = [];
    answer = () => ({ ok: true });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(answer(url)), {
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
    [asked({ slow: true }), `Rejoin asked ${time} · not back yet.`],
    [
      asked({ state: "closed" }),
      "Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.",
    ],
    [
      asked({ state: "closed", refused: true }),
      "Codex didn't take it; nothing is waiting there.",
    ],
    [
      asked({ state: "closed", declined: true }),
      "It says it was stopped in Codex, so it didn't come back. Paste the rejoin prompt there.",
    ],
    [asked({ state: "joined" }), "Joined · waiting for its first check."],
    [
      asked({ state: "joined", slow: true }),
      "Joined, but not waiting yet. Look at its conversation in Codex, or paste the rejoin prompt.",
    ],
  ])("says what became of it (%#)", (request, text) => {
    vi.spyOn(Date, "now").mockReturnValue(at);
    expect(rejoinText(rejoin({ request }))).toBe(text);
    card(rejoin({ request, can_open: true }), { state: "waiting" });
    expect(screen.getByRole("status").textContent).toBe(text);
    // The manual prompts are there in every state.
    expect(screen.getByText("Join prompts")).toBeTruthy();
    expect(screen.getByText("Copy rejoin prompt")).toBeTruthy();
    expect(screen.getByText("Copy full prompt")).toBeTruthy();
    const waiting = request.state === "waiting";
    const cancel = screen.queryByRole("button", { name: "Cancel" });
    expect(cancel !== null).toBe(waiting);
    if (cancel) expect(cancel.title).toBe(CANCEL_HELP.codex);
    // What to do is said at once, not later.
    expect(
      screen.queryByText(/“Queue paused”, press Resume there/) !== null,
    ).toBe(waiting);
    expect(document.body.textContent).not.toMatch(/is back|has returned/);
  });

  it.each([
    [
      asked({ unsure: true }),
      `Rejoin asked ${time} · Konfab couldn't tell whether its watcher took it.`,
    ],
    [asked({ slow: true }), `Rejoin asked ${time} · not back yet.`],
    [
      asked({ state: "closed" }),
      "Rejoin closed. A wake-up may still come; it can start a short turn, but can't rejoin.",
    ],
    [
      asked({ state: "closed", refused: true }),
      "Its watcher didn't take it; nothing was sent.",
    ],
    [
      asked({ state: "closed", declined: true }),
      "It says it was stopped in Claude, so it didn't come back. Paste the rejoin prompt there.",
    ],
    [
      asked({ state: "joined", slow: true }),
      "Joined, but not waiting yet. Look at its conversation in Claude, or paste the rejoin prompt.",
    ],
  ])("speaks of the other app in its own words (%#)", (request, text) => {
    const state = rejoin({ app: "claude", request, can_open: true });
    expect(rejoinText(state)).toBe(text);
    card(state, { state: "waiting" });
    expect(document.body.textContent).not.toContain("Codex");
    expect(rejoinHint(state) ?? "").toMatch(
      request.state === "waiting" ? /pressed Stop in Claude/ : /^$/,
    );
  });

  it("turns into “not back yet” by itself", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(at);
      card(rejoin({ request: asked(), can_open: true }));
      const open = screen.getByRole("button", { name: "Open Codex" });
      expect(open.className).toBe("secondary");
      actNow(() => void vi.advanceTimersByTime(20_000));
      expect(screen.getByRole("status").textContent).toContain("not back yet");
      expect(open.className).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["no_watcher", "Its watcher isn't running, so paste the prompt."],
    ["watchers_full", "Closing Claude normally ends them"],
    ["old_join", "restart the Konfab connector in Claude"],
    ["unavailable", "npm run doctor says why"],
    [null, ""],
  ] as const)(
    "is never a dead end for an agent that is away: %s",
    async (offer, text) => {
      card(rejoin({ app: "claude", offer, can_open: true, resting: 2 }));
      if (text) expect(screen.getByText(new RegExp(text))).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Rejoin" })).toBeNull();
      const button = screen.getByRole("button", {
        name: "Open Claude and copy the prompt",
      });
      answer = () => ({ opened: true, here: false });
      const user = userEvent.setup();
      await user.click(button);
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        "POST /api/rooms/4/agents/codex/open",
      ]);
      expect(await navigator.clipboard.readText()).toBe(
        "Rejoin Konfab room konfab",
      );
      expect(
        screen.getByText(
          "Prompt copied. Asked Claude to open. Choose this agent's conversation and paste.",
        ),
      ).toBeTruthy();
      // Never said: that it opened.
      expect(document.body.textContent).not.toMatch(/Opened|is open/);
    },
  );

  it.each([
    [{ opened: false, here: false }, "Couldn't ask Claude to open."],
    [{ opened: true, here: true }, "It has just come back. Don't paste."],
  ])("says what is known after a click (%#)", async (result, text) => {
    card(rejoin({ app: "claude", offer: "no_watcher", can_open: true }));
    answer = () => result;
    await userEvent.click(
      screen.getByRole("button", { name: "Open Claude and copy the prompt" }),
    );
    expect(screen.getByText(new RegExp(text))).toBeTruthy();
  });

  it.each(["denied", "missing"])(
    "has its own result when copying fails, with the prompt to copy by hand: %s",
    async (how) => {
      const user = userEvent.setup();
      vi.spyOn(navigator, "clipboard", "get").mockReturnValue(
        (how === "missing"
          ? undefined
          : {
              writeText: () => Promise.reject(new Error("denied")),
            }) as unknown as Clipboard,
      );
      card(rejoin({ app: "claude", offer: "no_watcher", can_open: true }));
      answer = () => ({ opened: true, here: false });
      await user.click(
        screen.getByRole("button", { name: "Open Claude and copy the prompt" }),
      );
      expect(screen.getByText(/Couldn't copy the prompt/)).toBeTruthy();
      expect(screen.getByText(/Asked Claude to open/)).toBeTruthy();
      const prompt =
        screen.getByLabelText<HTMLTextAreaElement>("Rejoin prompt");
      expect(prompt.value).toBe("Rejoin Konfab room konfab");
      expect(prompt.selectionEnd).toBe(prompt.value.length);
    },
  );

  it("warns before a paste while a request is open, and Codex has nothing to paste", async () => {
    answer = () => ({ opened: true, here: false });
    card(rejoin({ app: "claude", request: asked(), can_open: true }));
    await userEvent.click(
      screen.getByRole("button", { name: "Open Claude and copy the prompt" }),
    );
    expect(document.body.textContent).toContain(PASTE_WARNING);
    cleanup();
    card(rejoin({ request: asked(), can_open: true }));
    await userEvent.click(screen.getByRole("button", { name: "Open Codex" }));
    expect(document.body.textContent).not.toContain("copied");
    expect(document.body.textContent).not.toContain(PASTE_WARNING);
    // Where no app can be opened, the label says so.
    cleanup();
    card(rejoin({ request: asked() }));
    expect(
      screen.getByRole("button", { name: "Copy the prompt" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("names every label that opens an app or copies", () => {
    for (const app of ["codex", "claude"] as const)
      for (const can_open of [true, false])
        for (const state of [
          rejoin({ app, can_open, request: asked() }),
          rejoin({ app, can_open, offer: "no_watcher" }),
        ]) {
          card(state);
          const label = screen
            .getAllByRole("button")
            .map((button) => button.textContent!)
            .find((text) => /^(Open|Copy the)/.test(text))!;
          expect(/copy/i.test(label)).toBe(
            !(app === "codex" && can_open && state.request),
          );
          expect(label.startsWith("Open")).toBe(can_open);
          cleanup();
        }
  });

  it("shows nothing where it isn't offered, also with an older server", () => {
    expect(card(rejoin()).container.textContent).toBe("");
    expect(card(undefined).container.textContent).toBe("");
  });

  it("asks once, with the keyboard", async () => {
    card(rejoin({ offer: "ready" }));
    expect(screen.getByRole("button", { name: "Rejoin" }).title).toContain(
      "Experimental",
    );
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

  it("is greyed out only while the agent is there, and says why", async () => {
    card(rejoin({ offer: "connected" }), { state: "waiting" });
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rejoin",
    });
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Available when the agent is away.");
    await userEvent.click(button);
    expect(calls).toEqual([]);
    // Nothing to paste while it is there.
    expect(screen.queryByText("Join prompts")).toBeNull();
  });

  it.each(["old_join", "unavailable", "no_watcher", "ready"] as const)(
    "never leads to a paste while the agent is there: %s",
    (offer) => {
      for (const state of [
        "working",
        "waiting",
        "queued",
        "waiting_approval",
      ]) {
        const here = agent(rejoin({ offer, can_open: true }), { state });
        render(<RejoinControls room={room()} agent={here} act={act} />);
        render(<RejoinAgents room={room()} agents={[here]} act={act} />);
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "Rejoin" })
            .disabled,
        ).toBe(true);
        expect(
          screen.getByRole<HTMLButtonElement>("button", {
            name: "Rejoin agents",
          }).disabled,
        ).toBe(true);
        expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
        expect(screen.queryByText("Join prompts")).toBeNull();
        expect(
          screen.queryByText(/restart the Konfab connector/) !== null,
        ).toBe(offer === "old_join");
        cleanup();
      }
    },
  );

  it.each([
    ["elsewhere", "Its conversation is in another room now."],
    ["archived", "The room is archived."],
  ] as const)("offers only the prompts: %s", (offer, text) => {
    card(rejoin({ offer, can_open: true }));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText("Join prompts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open|^Rejoin/ })).toBeNull();
  });

  it.each([
    [{ paused: true }, "paused", "Resume and rejoin", ["pause"]],
    [{ on_break: true }, "on_break", "End the break and rejoin", ["break"]],
    [
      { paused: true, on_break: true },
      "paused",
      "Resume, end the break and rejoin",
      ["pause", "break"],
    ],
  ] as const)(
    "names the whole room before it resumes (%#)",
    async (now, offer, label, open) => {
      const state = rejoin({ offer, then: "ready", can_open: true });
      card(state, {}, room({ ...now, queued: ["Claude", "Second"] }));
      await userEvent.click(screen.getByRole("button", { name: label }));
      const dialog = screen.getByRole("dialog", { name: label });
      expect(calls).toEqual([]);
      expect(dialog.textContent).toContain("whole room");
      expect(dialog.textContent).toContain(
        "Queued turns can start: Claude, Second.",
      );
      expect(dialog.textContent).toContain("Codex will be asked");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Cancel" }),
      );
      expect(calls).toEqual([]);
      await userEvent.click(screen.getByRole("button", { name: label }));
      answer = () => ({
        opened: open,
        results: [{ agent_id: "codex", ok: true }],
      });
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: label,
        }),
      );
      expect(calls).toEqual([
        {
          url: "/api/rooms/4/rejoin",
          method: "POST",
          body: { open, agents: [{ id: "codex", again: false }] },
        },
      ]);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("only resumes, and says first what was done when the second step fails", async () => {
    const paused = rejoin({ offer: "paused", then: "ready" });
    card(paused, {}, room({ paused: true }));
    const start = () =>
      userEvent.click(
        screen.getByRole("button", { name: "Resume and rejoin" }),
      );
    await start();
    answer = () => ({ opened: ["pause"], results: [] });
    await userEvent.click(screen.getByRole("button", { name: "Only resume" }));
    expect(calls[0]!.body).toEqual({ open: ["pause"], agents: [] });
    await start();
    answer = () => ({
      opened: ["pause"],
      results: [{ agent_id: "codex", ok: false, error: "Not now" }],
    });
    const buttons = screen.getAllByRole("button", {
      name: "Resume and rejoin",
    });
    await userEvent.click(buttons.at(-1)!);
    expect(screen.getByRole("dialog").textContent).toMatch(
      /The room is resumed\..*Codex.*wasn't asked: Not now/,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leads on in a paused room when it can't be asked, or all rooms are paused", () => {
    card(
      rejoin({ offer: "paused", then: "no_watcher", can_open: true }),
      {},
      room({ paused: true }),
    );
    expect(document.body.textContent).toContain("The room is paused.");
    expect(
      screen.getByRole("button", { name: "Open Codex and copy the prompt" }),
    ).toBeTruthy();
    cleanup();
    card(
      rejoin({ offer: "paused", then: "ready", all_paused: true }),
      {},
      room({ paused: true }),
    );
    expect(document.body.textContent).toContain(
      "All rooms are paused; resume them first.",
    );
    expect(
      screen.queryByRole("button", { name: "Resume and rejoin" }),
    ).toBeNull();
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
    expect(CANCEL_HELP.codex).toContain("can't take back the prompt in Codex");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([
      {
        url: "/api/rooms/4/agents/codex/rejoin",
        method: "DELETE",
        body: null,
      },
    ]);
  });

  it("asks all agents it is ready for, after showing which, and lists those that need the lead", async () => {
    const agents = [
      agent(rejoin({ offer: "ready" })),
      agent(rejoin({ offer: "ready", earlier: true }), {
        id: "codex2",
        display_name: "Second",
      }),
      agent(rejoin({ offer: "elsewhere" }), {
        id: "third",
        display_name: "Third",
      }),
      agent(rejoin(), { id: "other", display_name: "Other" }),
      agent(rejoin({ offer: "connected" }), { id: "in", display_name: "In" }),
    ];
    const view = render(
      <RejoinAgents room={room()} agents={agents} act={act} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    let dialog = screen.getByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "CodexCodex will be asked",
      `SecondCodex will be asked · ${EARLIER_NOTE}`,
    ]);
    expect(dialog.textContent).toContain("Experimental");
    expect(dialog.textContent).toContain("uses their allowance");
    expect(dialog.textContent).not.toContain("whole room");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual([]);

    view.rerender(
      <RejoinAgents
        room={room()}
        agents={[
          ...agents,
          agent(
            rejoin({ app: "claude", offer: "no_watcher", can_open: true }),
            {
              id: "claude",
              display_name: "Claude",
            },
          ),
        ]}
        act={act}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("These need you:Claude");
    answer = () => ({
      opened: [],
      results: [
        { agent_id: "codex", ok: true },
        { agent_id: "codex2", ok: true },
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Send new prompts" }),
    );
    expect(calls).toEqual([
      {
        url: "/api/rooms/4/rejoin",
        method: "POST",
        body: {
          open: [],
          agents: [
            { id: "codex", again: false },
            { id: "codex2", again: true },
          ],
        },
      },
    ]);
    // It stays for the one that needs the lead.
    expect(screen.getByRole("dialog").textContent).toContain("Claude");
    expect(
      screen.getByRole("button", { name: "Open Claude and copy the prompt" }),
    ).toBeTruthy();
  });

  it("shows that it is asking, and asks once", async () => {
    let done!: () => void;
    const asking = new Promise<void>((resolve) => (done = resolve));
    const post = vi.fn(async () => {
      await asking;
      return new Response(JSON.stringify({ opened: [], results: [] }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", post);
    render(
      <RejoinAgents
        room={room()}
        agents={[agent(rejoin({ offer: "ready" }))]}
        act={act}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    await userEvent.click(screen.getByRole("button", { name: "Asking…" }));
    expect(post).toHaveBeenCalledTimes(1);
    await actNow(async () => {
      done();
      await asking;
    });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the question when the server refuses everything", async () => {
    const refused = vi.fn();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ message: "This room is archived" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    render(
      <RejoinAgents
        room={room()}
        agents={[agent(rejoin({ offer: "ready" }))]}
        act={(action) => action().then(() => undefined, refused)}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Rejoin agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejoin" }));
    expect(refused).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no room button where it is for nobody, and a greyed-out one while nobody can be asked", () => {
    const { container, rerender } = render(
      <RejoinAgents room={room()} agents={[agent(rejoin())]} act={act} />,
    );
    expect(container.textContent).toBe("");
    rerender(
      <RejoinAgents
        room={room()}
        agents={[agent(rejoin({ offer: "connected" }))]}
        act={act}
      />,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Rejoin agents",
    });
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Available when an agent is away");
  });
});
