// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PhoneNotices,
  type PhoneSetupView,
  type PhoneView,
} from "../../web/src/PhoneNotices";
import {
  OLD_QUESTION,
  PhoneSetup,
  REMOVE_QUESTION,
} from "../../web/src/PhoneSetup";

const ID = "11111111-1111-4111-8111-111111111111";
const step = (changes: Partial<PhoneSetupView> = {}): PhoneSetupView => ({
  id: ID,
  way: "terminal",
  step: "token",
  command: "npm run setup -- --telegram --token-only ABC234",
  busy: false,
  again: false,
  bot: null,
  code: null,
  seconds_left: null,
  chat_name: null,
  arrived: null,
  problem: null,
  ...changes,
});
const none: PhoneView = {
  state: "not_set_up",
  chat_name: null,
  away_minutes: 10,
  problem: null,
  setup: null,
  ways: ["terminal"],
  left_over: [],
};
const on: PhoneView = { ...none, state: "on", chat_name: "Lead" };

describe("setting up phone notices in the page", () => {
  let view: PhoneView;
  let calls: { url: string; method: string; body: unknown }[];
  let answer: () => [number, object] | Promise<[number, object]>;
  const open = async () => {
    render(<PhoneSetup />);
    await screen.findByRole("region", { name: "Phone notices" });
  };
  const at = async (changes: Partial<PhoneSetupView>) => {
    view = { ...none, setup: step(changes) };
    await open();
  };
  const press = (name: string) =>
    userEvent.click(screen.getByRole("button", { name }));
  const sent = () =>
    calls
      .filter((call) => call.method !== "GET")
      .map(({ url, body }) => [url.replace("/api/phone-notices", ""), body]);

  beforeEach(() => {
    view = none;
    calls = [];
    answer = () => [200, view];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        url,
        method,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const [status, body] = method === "GET" ? [200, view] : await answer();
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts only after it says what it does", async () => {
    await open();
    await press("Set up…");
    expect(document.activeElement?.textContent).toBe("Set up phone notices");
    expect(document.body.textContent).toContain("never through this page");
    expect(document.body.textContent).toContain("contacts Telegram");
    expect(sent()).toEqual([]);
    await press("Cancel");
    await press("Set up…");
    view = { ...none, setup: step() };
    await press("Start");
    expect(sent()).toEqual([["/setup", { way: "terminal" }]]);
    expect(document.activeElement?.textContent).toContain("Your bot");
    expect(screen.getByText(/--token-only ABC234/)).toBeTruthy();
    // There is no field that a token could be put into.
    expect(document.querySelector("input, textarea")).toBeNull();
  });

  it("says where the token comes from on this computer", async () => {
    view = { ...none, ways: ["env"] };
    await open();
    await press("Set up…");
    expect(document.body.textContent).toContain(
      "uses the token from KONFAB_TELEGRAM_TOKEN",
    );
    cleanup();
    view = { ...none, ways: [] };
    await open();
    await press("Set up…");
    expect(document.body.textContent).toContain("start Konfab again");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it.each([
    [{ step: "token", again: true, command: null }, "Try again", "again", {}],
    [{ step: "bot", bot: "b" }, "Show a code", "code", {}],
    [{ step: "chat", chat_name: "Lead" }, "Send a test", "test", {}],
    [
      { step: "chat", chat_name: "Lead" },
      "Skip the test",
      "confirm",
      { arrived: true },
    ],
    [
      { step: "chat", chat_name: "Lead" },
      "It isn't me",
      "confirm",
      { arrived: false },
    ],
    [
      { step: "test", chat_name: "Lead" },
      "Yes, it arrived",
      "confirm",
      { arrived: true },
    ],
    [{ step: "test", chat_name: "Lead" }, "No", "confirm", { arrived: false }],
    [{ step: "test", chat_name: "Lead" }, "Send again", "test", {}],
    [
      { step: "finish", chat_name: "Lead" },
      "Turn on",
      "finish",
      { enabled: true },
    ],
    [
      { step: "finish", chat_name: "Lead" },
      "Finish, off",
      "finish",
      { enabled: false },
    ],
    [{ step: "code", code: "X", seconds_left: 5 }, "Cancel", "cancel", {}],
  ] as [Partial<PhoneSetupView>, string, string, object][])(
    "has one button for each step (%#)",
    async (changes, name, path, body) => {
      await at(changes);
      await press(name);
      expect(sent()).toEqual([[`/setup/${path}`, { id: ID, ...body }]]);
    },
  );

  it("shows the code and the time, read aloud by the minute only", async () => {
    await at({
      step: "code",
      code: "KONFAB-ABCDE-23456",
      bot: "konfab_bot",
      seconds_left: 272,
    });
    expect(screen.getByText("KONFAB-ABCDE-23456")).toBeTruthy();
    expect(screen.getByText("4:32 left").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.getByText("5 minutes left").getAttribute("role")).toBe(
      "status",
    );
  });

  it("says when there was no test, and what went wrong", async () => {
    await at({ step: "finish", chat_name: "Lead" });
    expect(document.body.textContent).toContain("without a test");
    cleanup();
    await at({ step: "finish", chat_name: "Lead", arrived: true });
    expect(document.body.textContent).not.toContain("without a test");
    cleanup();
    await at({ step: "bot", bot: "b", problem: "Telegram can't be reached." });
    expect(screen.getByRole("alert").textContent).toBe(
      "Telegram can't be reached.",
    );
    answer = () => [409, { message: "This setup has ended" }];
    await press("Show a code");
    expect(
      screen.getAllByRole("alert").map((item) => item.textContent),
    ).toContain("This setup has ended");
  });

  it("can be cancelled while it is busy, and nothing else", async () => {
    await at({ step: "bot", bot: "b", busy: true });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Show a code" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" })
        .disabled,
    ).toBe(false);
  });

  it("looks often while a setup is under way, and goes on by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await at({});
    const before = calls.length;
    view = { ...none, setup: step({ step: "bot", bot: "b" }) };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(calls.length).toBeGreaterThan(before);
    expect(document.activeElement?.textContent).toContain("Your chat");
    view = none;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
    const after = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls.length - after).toBeLessThanOrEqual(1);
  });

  it("doesn't show an answer from before a step after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await at({ step: "bot", bot: "b" });
    const old = view;
    let late!: () => void;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method !== "GET") return real(url, init);
      await new Promise<void>((done) => (late = done));
      return new Response(JSON.stringify(old), {
        headers: { "content-type": "application/json" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    view = {
      ...none,
      setup: step({ step: "code", code: "KONFAB-X", seconds_left: 300 }),
    };
    await press("Show a code");
    expect(screen.getByText("KONFAB-X")).toBeTruthy();
    await act(async () => {
      late();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("KONFAB-X")).toBeTruthy();
  });

  it("tests, sets up again and removes what is set up", async () => {
    view = on;
    await open();
    await press("Send a test");
    expect(await screen.findByText("Sent “Konfab: test”.")).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await press("Remove");
    expect(confirm).toHaveBeenCalledWith(REMOVE_QUESTION);
    expect(sent()).toEqual([["/test", {}]]);
    confirm.mockReturnValue(true);
    await press("Remove");
    expect(sent().at(-1)).toEqual(["/remove", {}]);
    await press("Set up again");
    expect(document.body.textContent).toContain(
      "goes on working until the last step",
    );
    cleanup();
    answer = () => [409, { message: "macOS didn't give the bot token." }];
    await open();
    await press("Send a test");
    expect(screen.getByRole("alert").textContent).toContain("macOS didn't");
    expect(screen.queryByText("Sent “Konfab: test”.")).toBeNull();
  });

  it("shows what is left over, and asks before one of an earlier version", async () => {
    view = {
      ...none,
      left_over: [
        { item: "konfab-telegram-token-x", at: 1, unsure: false, old: false },
        { item: "konfab-telegram-token-y", at: 1, unsure: true, old: false },
        { item: "konfab-telegram-token-a", at: 1, unsure: false, old: true },
      ],
    };
    await open();
    expect(document.body.textContent).toContain("It isn't known whether");
    const buttons = screen.getAllByRole("button", { name: "Remove it" });
    await userEvent.click(buttons[0]!);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(buttons[2]!);
    expect(confirm).toHaveBeenCalledWith(OLD_QUESTION);
    confirm.mockReturnValue(true);
    await userEvent.click(buttons[2]!);
    expect(sent()).toEqual([
      ["/left-over", { item: "konfab-telegram-token-x", elsewhere: false }],
      ["/left-over", { item: "konfab-telegram-token-a", elsewhere: true }],
    ]);
  });

  it("leads there from Lead, and works with an older server", async () => {
    const onSetUp = vi.fn();
    render(<PhoneNotices onSetUp={onSetUp} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set up…" }),
    );
    expect(onSetUp).toHaveBeenCalledOnce();
    cleanup();
    view = {
      state: "not_set_up",
      chat_name: null,
      away_minutes: 10,
      problem: null,
    };
    render(<PhoneNotices onSetUp={onSetUp} />);
    expect(await screen.findByText("npm run setup -- --telegram")).toBeTruthy();
  });
});
