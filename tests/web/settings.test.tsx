// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromField, QUESTIONS, Settings } from "../../web/src/Settings";

type Row = Record<string, unknown> & { key: string };
const row = (key: string, changes: object = {}): Row => ({
  key,
  section: key.startsWith("phone") ? "phone" : "rejoin",
  name: key,
  help: `Help for ${key}`,
  control: { type: "switch" },
  effect: "now",
  effect_text: "At once",
  page: "edit",
  saved: true,
  in_use: true,
  default: true,
  ...changes,
});
const number = (key: string, value: number, usual = value): Row =>
  row(key, {
    control: { type: "number", min: 1, max: 60, unit: "min" },
    saved: value,
    in_use: value,
    default: usual,
  });

describe("the Settings page", () => {
  let view: Record<string, unknown> & { settings: Row[] };
  let calls: { method: string; url: string; body: unknown }[];
  let answer: (url: string) => [number, object];
  const dirty = vi.fn();
  const open = async (first: "phone" | "rejoin" = "rejoin") => {
    render(<Settings at={{ section: first }} onDirtyChange={dirty} />);
    await screen.findByRole("heading", { level: 2, name: "Settings" });
  };
  const writes = () =>
    calls.filter((call) => call.method !== "GET").map(({ body }) => body);

  beforeEach(() => {
    calls = [];
    dirty.mockReset();
    view = {
      hash: "h1",
      problem: null,
      platform: "darwin",
      command_to_agree: false,
      settings: [
        row("rejoin.enabled"),
        row("rejoin.claude_watcher", {
          saved: false,
          in_use: false,
          default: false,
          effect: "next_join",
          effect_text: "From the next join",
        }),
        number("rejoin.wanted_minutes", 10),
        row("rejoin.codex_command", {
          control: { type: "command" },
          saved: null,
          in_use: null,
          default: null,
        }),
        number("phone_notices.away_minutes", 5, 10),
        row("phone_notices.quiet_from", {
          control: { type: "time" },
          saved: null,
          in_use: null,
          default: null,
        }),
        row("server.port", { section: "advanced", page: "later" }),
      ],
    };
    answer = () => [200, view];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const [status, body] =
        url === "/api/phone-notices"
          ? [
              200,
              {
                state: "not_set_up",
                chat_name: null,
                away_minutes: 10,
                problem: null,
              },
            ]
          : method === "GET"
            ? [200, view]
            : answer(url);
      return new Response(JSON.stringify(body), {
        status: status as number,
        headers: { "content-type": "application/json" },
      });
    });
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

  it("shows one section at a time, with what isn't here yet", async () => {
    await open();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.queryByLabelText("phone_notices.away_minutes")).toBeNull();
    expect(screen.queryByLabelText("server.port")).toBeNull();
    expect(screen.getByText("npm run config")).toBeTruthy();
    expect(screen.getByText("From the next join.")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Phone notices" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Phone notices" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByLabelText("phone_notices.away_minutes")).toBeTruthy();
    expect(await screen.findByText(/Not set up/)).toBeTruthy();
  });

  it("saves a switch by its click, after a question where it needs one", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open();
    const watcher = screen.getByRole("switch", {
      name: "rejoin.claude_watcher",
    });
    await userEvent.click(watcher);
    expect(confirm).toHaveBeenCalledWith(
      QUESTIONS["rejoin.claude_watcher"]!.on,
    );
    expect(writes()).toEqual([]);
    confirm.mockReturnValue(true);
    watcher.focus();
    await userEvent.keyboard(" ");
    expect(writes()).toEqual([
      { hash: "h1", set: { "rejoin.claude_watcher": true } },
    ]);
    expect(screen.getByText("Saved: rejoin.claude_watcher, on.")).toBeTruthy();
    confirm.mockClear();
    await userEvent.click(
      screen.getByRole("switch", { name: "rejoin.enabled" }),
    );
    expect(confirm).toHaveBeenCalledWith(QUESTIONS["rejoin.enabled"]!.off);
  });

  it("saves numbers and times together, and discards them", async () => {
    await open("phone");
    const minutes = screen.getByLabelText("phone_notices.away_minutes");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "7");
    await userEvent.type(
      screen.getByLabelText("phone_notices.quiet_from"),
      "22:00",
    );
    expect(dirty).toHaveBeenLastCalledWith(true);
    expect(
      screen.getByText(
        /2 changes: phone_notices.away_minutes, 5 → 7 · phone_notices.quiet_from, none → 22:00/,
      ),
    ).toBeTruthy();
    expect(writes()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect((minutes as HTMLInputElement).value).toBe("5");
    expect(dirty).toHaveBeenLastCalledWith(false);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "7");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writes()).toEqual([
      { hash: "h1", set: { "phone_notices.away_minutes": 7 } },
    ]);
  });

  it("has Agents and Advanced, with lists, an agent's own values and a question first", async () => {
    view.settings.push(
      row("defaults.run_warnings_minutes", {
        section: "agents",
        control: { type: "minutes", max: 1440, most: 20 },
        saved: [30, 10, 5],
        in_use: [30, 10, 5],
        default: [30, 10, 5],
      }),
      {
        ...number("agents.claude.run_hours", 0),
        section: "agents",
        saved: null,
        in_use: null,
        default: null,
        control: { type: "number", min: 1, max: 24, unit: "h", decimal: true },
      },
      { ...number("defaults.turn_timeout_minutes", 30), section: "agents" },
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const warnings = screen.getByLabelText("defaults.run_warnings_minutes");
    expect((warnings as HTMLInputElement).value).toBe("30, 10, 5");
    // Lists are compared by what is in them: nothing to save, no Reset.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Reset defaults.run_warnings_minutes",
      }),
    ).toBeNull();
    await userEvent.clear(warnings);
    await userEvent.type(warnings, "15, x");
    expect(screen.getByRole("alert").textContent).toMatch(
      /separated by commas/,
    );
    await userEvent.clear(warnings);
    await userEvent.type(warnings, "15,5");
    const hours = screen.getByLabelText("agents.claude.run_hours");
    await userEvent.type(hours, "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writes()).toEqual([
      {
        hash: "h1",
        set: {
          "defaults.run_warnings_minutes": [15, 5],
          "agents.claude.run_hours": 2.5,
        },
      },
    ]);
  });

  it("asks the server's question before saving, and saves nothing without a yes", async () => {
    view.settings.push({
      ...number("defaults.turn_timeout_minutes", 30),
      section: "agents",
    });
    const question =
      "A silent turn that is already longer than 5 minutes is ended at the next look. Shorten it?";
    answer = () => {
      const last = calls.at(-1)!.body as { confirmed?: string[] };
      return last.confirmed
        ? [200, view]
        : [409, { code: "settings_confirm", message: question }];
    };
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    const limit = screen.getByLabelText("defaults.turn_timeout_minutes");
    await userEvent.clear(limit);
    await userEvent.type(limit, "5");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(confirm).toHaveBeenCalledWith(question);
    expect(writes()).toHaveLength(1);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writes().at(-1)).toEqual({
      hash: "h1",
      set: { "defaults.turn_timeout_minutes": 5 },
      confirmed: ["defaults.turn_timeout_minutes"],
    });
  });

  it("takes an empty value of an agent's own as the default", async () => {
    view.settings.push({
      ...number("agents.claude.run_hours", 3),
      section: "agents",
      default: null,
      control: { type: "number", min: 1, max: 24, decimal: true },
    });
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Agents" }));
    await userEvent.clear(screen.getByLabelText("agents.claude.run_hours"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writes()).toEqual([
      { hash: "h1", set: {}, reset: ["agents.claude.run_hours"] },
    ]);
  });

  it("adds a pre-approval after the server's question, and removes one at once", async () => {
    view.settings.push(
      row("pre_approvals", {
        section: "approvals",
        control: { type: "approvals" },
        saved: [{ recipient: "github.com/a/b", data: "code_push" }],
        in_use: [],
        default: [],
      }),
    );
    const question =
      "From now on, agents may send file_upload to github.com/c/d without asking you, in every room and in every future request, until you remove it. Each use is still logged. Allow it?";
    answer = () => {
      const last = calls.at(-1)!.body as { add: boolean; confirmed: boolean };
      return last.add && !last.confirmed
        ? [409, { code: "settings_confirm", message: question }]
        : [200, view];
    };
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: "Pre-approvals" }),
    );
    expect(screen.getByText("code_push")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove code_push to github.com/a/b",
      }),
    );
    expect(writes()).toEqual([
      {
        recipient: "github.com/a/b",
        data: "code_push",
        add: false,
        confirmed: false,
      },
    ]);
    await userEvent.type(screen.getByLabelText("Kind of data"), "file_upload");
    await userEvent.type(screen.getByLabelText("Recipient"), "github.com/c/d");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Add…" }));
    expect(confirm).toHaveBeenCalledWith(question);
    expect(writes()).toHaveLength(2);
    expect((screen.getByLabelText("Recipient") as HTMLInputElement).value).toBe(
      "github.com/c/d",
    );
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Add…" }));
    expect(writes().at(-1)).toEqual({
      recipient: "github.com/c/d",
      data: "file_upload",
      add: true,
      confirmed: true,
    });
    expect((screen.getByLabelText("Recipient") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("says beside its field what is wrong, and saves nothing", async () => {
    await open("phone");
    const minutes = screen.getByLabelText("phone_notices.away_minutes");
    for (const wrong of ["0", "61", "1.5", "x", " "]) {
      await userEvent.clear(minutes);
      await userEvent.type(minutes, wrong);
      expect(screen.getByRole("alert").textContent).toBe(
        "A whole number from 1 to 60",
      );
      expect(minutes.getAttribute("aria-invalid")).toBe("true");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Save" })
          .disabled,
      ).toBe(true);
    }
    expect(writes()).toEqual([]);
    expect(fromField({ control: { type: "time" } }, "")).toEqual({
      value: null,
    });
    expect(fromField({ control: { type: "time" } }, "9:00")).toHaveProperty(
      "wrong",
    );
  });

  it("resets what isn't the default", async () => {
    await open("phone");
    const reset = screen.getByRole("button", {
      name: "Reset phone_notices.away_minutes",
    });
    expect(reset.title).toBe("Default: 10");
    expect(screen.getAllByRole("button", { name: /^Reset/ })).toHaveLength(1);
    await userEvent.click(reset);
    expect(writes()).toEqual([
      { hash: "h1", reset: ["phone_notices.away_minutes"] },
    ]);
  });

  it("keeps a typed value and shows the new ones when the file has changed", async () => {
    await open();
    const minutes = screen.getByLabelText<HTMLInputElement>(
      "rejoin.wanted_minutes",
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "20");
    answer = () => {
      view = { ...view, hash: "h2" };
      return [409, { code: "settings_changed", message: "changed" }];
    };
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Nothing was saved",
    );
    expect(minutes.value).toBe("20");
    answer = () => [200, view];
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writes().at(-1)).toMatchObject({ hash: "h2" });
  });

  /** Another writer's change, and the next look of the page. */
  const elsewhere = async (key: string, value: unknown) => {
    view = {
      ...view,
      hash: `${view.hash}+`,
      settings: view.settings.map((setting) =>
        setting.key === key
          ? { ...setting, saved: value, in_use: value }
          : setting,
      ),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  };
  const typing = async (value: string) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    const minutes = screen.getByLabelText<HTMLInputElement>(
      "rejoin.wanted_minutes",
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, value);
    return minutes;
  };
  const saveButton = () =>
    screen.getByRole<HTMLButtonElement>("button", { name: "Save" });

  it("doesn't overwrite a newer value that came while the lead typed", async () => {
    try {
      const minutes = await typing("20");
      expect(saveButton().disabled).toBe(false);
      await elsewhere("rejoin.wanted_minutes", 45);
      expect(minutes.value).toBe("20");
      expect(screen.getByRole("alert").textContent).toContain(
        "Changed elsewhere to 45 while you typed.",
      );
      expect(saveButton().disabled).toBe(true);
      await userEvent.click(saveButton());
      // Typing on doesn't settle it.
      await userEvent.type(minutes, "1");
      expect(saveButton().disabled).toBe(true);
      expect(writes()).toEqual([]);
      await userEvent.click(
        screen.getByRole("button", { name: "Keep mine (201)" }),
      );
      await userEvent.clear(minutes);
      await userEvent.type(minutes, "21");
      expect(screen.queryByRole("alert")).toBeNull();
      await userEvent.click(saveButton());
      expect(writes()).toEqual([
        { hash: "h1+", set: { "rejoin.wanted_minutes": 21 } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the newer value when the lead says so, and asks again after another change", async () => {
    try {
      const minutes = await typing("20");
      await elsewhere("rejoin.wanted_minutes", 45);
      await userEvent.click(
        screen.getByRole("button", { name: "Keep mine (20)" }),
      );
      expect(saveButton().disabled).toBe(false);
      await elsewhere("rejoin.wanted_minutes", 46);
      expect(saveButton().disabled).toBe(true);
      await userEvent.click(screen.getByRole("button", { name: "Use 46" }));
      expect(minutes.value).toBe("46");
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      expect(writes()).toEqual([]);
      // What is typed from there starts from that value.
      await userEvent.clear(minutes);
      await userEvent.type(minutes, "5");
      expect(saveButton().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isn't held up by a change of another setting, or of the same to the same value", async () => {
    try {
      await typing("20");
      await elsewhere("rejoin.enabled", false);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(saveButton().disabled).toBe(false);
      await userEvent.click(saveButton());
      expect(writes()).toEqual([
        { hash: "h1+", set: { "rejoin.wanted_minutes": 20 } },
      ]);
      cleanup();
      vi.useRealTimers();
      view.settings = view.settings.map((setting) =>
        setting.key === "rejoin.wanted_minutes"
          ? number("rejoin.wanted_minutes", 10)
          : setting,
      );
      await typing("30");
      await elsewhere("rejoin.wanted_minutes", 30);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sees a change that comes in the middle of saving", async () => {
    try {
      const minutes = await typing("20");
      // The server refuses, because the file isn't the one that was shown.
      answer = () => {
        view = {
          ...view,
          hash: "h2",
          settings: view.settings.map((setting) =>
            setting.key === "rejoin.wanted_minutes"
              ? { ...setting, saved: 45, in_use: 45 }
              : setting,
          ),
        };
        return [409, { code: "settings_changed", message: "changed" }];
      };
      await userEvent.click(saveButton());
      expect(minutes.value).toBe("20");
      expect(
        screen
          .getAllByRole("alert")
          .map((item) => item.textContent)
          .join(),
      ).toMatch(/Nothing was saved.*Changed elsewhere to 45/);
      expect(saveButton().disabled).toBe(true);
      expect(writes()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't show an answer from before a save after it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open();
      const old = view;
      let late!: () => void;
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url !== "/api/settings" || init?.method !== "GET")
          return real(url, init);
        await new Promise<void>((done) => (late = done));
        return new Response(JSON.stringify(old), {
          headers: { "content-type": "application/json" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      view = {
        ...view,
        hash: "h2",
        settings: view.settings.map((setting) =>
          setting.key === "rejoin.enabled"
            ? { ...setting, saved: false, in_use: false }
            : setting,
        ),
      };
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const enabled = screen.getByRole<HTMLInputElement>("switch", {
        name: "rejoin.enabled",
      });
      await userEvent.click(enabled);
      expect(enabled.checked).toBe(false);
      await act(async () => {
        late();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(enabled.checked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Holds back the answers of writes until they are let go. */
  const hold = () => {
    const waiting: (() => void)[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const answered = await real(url, init);
      if (init?.method !== "GET")
        await new Promise<void>((done) => waiting.push(done));
      return answered;
    });
    return async () => {
      await act(async () => {
        waiting.shift()!();
        await Promise.resolve();
      });
    };
  };
  const savedAs = (key: string, value: unknown) => {
    answer = () => {
      view = {
        ...view,
        hash: `${view.hash}+`,
        settings: view.settings.map((setting) =>
          setting.key === key
            ? { ...setting, saved: value, in_use: value }
            : setting,
        ),
      };
      return [200, view];
    };
  };

  it("keeps what is typed while a save is on its way", async () => {
    await open();
    const minutes = screen.getByLabelText<HTMLInputElement>(
      "rejoin.wanted_minutes",
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "20");
    savedAs("rejoin.wanted_minutes", 20);
    const go = hold();
    await userEvent.click(saveButton());
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "25");
    await go();
    expect(minutes.value).toBe("25");
    expect(
      screen.getByText(/1 change: rejoin.wanted_minutes, 20 → 25/),
    ).toBeTruthy();
    // Over the value just saved, so there is no conflict with it.
    expect(screen.queryByText(/Changed elsewhere/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
    savedAs("rejoin.wanted_minutes", 25);
    await userEvent.click(saveButton());
    await go();
    expect(writes()).toEqual([
      { hash: "h1", set: { "rejoin.wanted_minutes": 20 } },
      { hash: "h1+", set: { "rejoin.wanted_minutes": 25 } },
    ]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("keeps it also when that save fails, and sees another writer in between", async () => {
    await open();
    const minutes = screen.getByLabelText<HTMLInputElement>(
      "rejoin.wanted_minutes",
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "20");
    answer = () => [500, { message: "no" }];
    const go = hold();
    await userEvent.click(saveButton());
    await userEvent.type(minutes, "1");
    await go();
    expect(minutes.value).toBe("201");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "20");
    // Saved as 20, but by the answer it is another writer's 45 already.
    savedAs("rejoin.wanted_minutes", 45);
    await userEvent.click(saveButton());
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "30");
    await go();
    expect(minutes.value).toBe("30");
    expect(
      await screen.findByText(/Changed elsewhere to 45 while you typed/),
    ).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps what is typed while a reset is on its way", async () => {
    await open("phone");
    const minutes = screen.getByLabelText<HTMLInputElement>(
      "phone_notices.away_minutes",
    );
    savedAs("phone_notices.away_minutes", 10);
    const go = hold();
    await userEvent.click(
      screen.getByRole("button", { name: "Reset phone_notices.away_minutes" }),
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "7");
    await go();
    expect(minutes.value).toBe("7");
    expect(screen.queryByText(/Changed elsewhere/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps the other section's typing, while switching and saving", async () => {
    await open("phone");
    const away = () =>
      screen.getByLabelText<HTMLInputElement>("phone_notices.away_minutes");
    await userEvent.clear(away());
    await userEvent.type(away(), "7");
    const section = (name: string) =>
      userEvent.click(screen.getByRole("button", { name }));
    await section("Rejoin");
    const wanted = () =>
      screen.getByLabelText<HTMLInputElement>("rejoin.wanted_minutes");
    await userEvent.clear(wanted());
    await userEvent.type(wanted(), "20");
    savedAs("rejoin.wanted_minutes", 20);
    const go = hold();
    await userEvent.click(saveButton());
    await section("Phone notices");
    expect(away().value).toBe("7");
    await userEvent.type(away(), "1");
    await go();
    expect(away().value).toBe("71");
    expect(writes()).toEqual([
      { hash: "h1", set: { "rejoin.wanted_minutes": 20 } },
    ]);
    await section("Rejoin");
    expect(wanted().value).toBe("20");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("uses an answer about a command only for the path and dialog it was asked for", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    let dialog = screen.getByRole("dialog");
    const field = () =>
      within(dialog).getByLabelText<HTMLInputElement>("Absolute path");
    const press = (name: string) =>
      userEvent.click(within(dialog).getByRole("button", { name }));
    const use = () =>
      within(dialog).queryByRole("button", { name: "Use this file" });
    await userEvent.type(field(), "/opt/a");
    answer = () => [
      200,
      { ok: true, path: "/opt/a", stamp: "s", signed_by: null },
    ];
    const go = hold();
    await press("Look at it");
    await userEvent.type(field(), "b");
    await go();
    // Looked at /opt/a, but the field says /opt/ab.
    expect(use()).toBeNull();
    expect(dialog.textContent).not.toContain("Konfab will run");
    await press("Look at it");
    await go();
    expect(use()).not.toBeNull();
    answer = () => [200, view];
    await userEvent.click(use()!);
    await userEvent.type(field(), "c");
    expect(field().value).toBe("/opt/ab");
    // Closed and opened again: the late answer doesn't close this one.
    await press("Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    dialog = screen.getByRole("dialog");
    await go();
    expect(screen.getByRole("dialog")).toBe(dialog);
    await userEvent.type(field(), "/opt/d");
    expect(field().value).toBe("/opt/d");
  });

  it("asks before it replaces a command that was changed elsewhere", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Change…" }));
      const dialog = screen.getByRole("dialog");
      await userEvent.type(
        within(dialog).getByLabelText("Absolute path"),
        "/opt/mine",
      );
      answer = () => [
        200,
        { ok: true, path: "/opt/mine", stamp: "s", signed_by: null },
      ];
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Look at it" }),
      );
      await elsewhere("rejoin.codex_command", "/opt/theirs");
      expect(dialog.textContent).toContain("Changed elsewhere to /opt/theirs");
      const use = within(dialog).getByRole<HTMLButtonElement>("button", {
        name: "Use this file",
      });
      expect(use.disabled).toBe(true);
      expect(
        within(dialog).getByRole<HTMLButtonElement>("button", {
          name: "Use the app's own",
        }).disabled,
      ).toBe(true);
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Go on" }),
      );
      expect(use.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows saved and in use when they differ, and is off with a broken file", async () => {
    view.problem = "config.yaml has an error in line 3";
    view.settings[2] = {
      ...number("rejoin.wanted_minutes", 20),
      in_use: 10,
    };
    await open();
    expect(screen.getByRole("alert").textContent).toContain("line 3");
    expect(screen.getByText("Saved: 20. In use: 10.")).toBeTruthy();
    for (const control of [
      ...screen.getAllByRole<HTMLInputElement>("switch"),
      screen.getByLabelText<HTMLInputElement>("rejoin.wanted_minutes"),
      screen.getByRole<HTMLButtonElement>("button", { name: "Change…" }),
    ])
      expect(control.disabled).toBe(true);
  });

  it("chooses another command in steps, after looking only", async () => {
    await open();
    expect(screen.getByText("The app's own copy")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Change…" }));
    const dialog = screen.getByRole("dialog", { name: "Codex command" });
    expect(dialog.textContent).toContain("doesn't run it before you say yes");
    expect(
      within(dialog).queryByRole("button", { name: "Use this file" }),
    ).toBeNull();
    const field = within(dialog).getByLabelText("Absolute path");
    await userEvent.type(field, "/opt/codex");
    answer = () => [200, { ok: false, reason: "its path has a link" }];
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Look at it" }),
    );
    expect(dialog.textContent).toContain("can't be used: its path has a link");
    answer = () => [
      200,
      { ok: true, path: "/opt/codex", stamp: "s", signed_by: null },
    ];
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Look at it" }),
    );
    expect(dialog.textContent).toContain("Konfab will run /opt/codex as you");
    expect(dialog.textContent).toContain("isn't signed");
    // Another path needs another look.
    await userEvent.type(field, "2");
    expect(
      within(dialog).queryByRole("button", { name: "Use this file" }),
    ).toBeNull();
    answer = () => [
      200,
      { ok: true, path: "/opt/codex2", stamp: "s2", signed_by: "Someone" },
    ];
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Look at it" }),
    );
    expect(dialog.textContent).toContain("not a guarantee");
    answer = () => [200, view];
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Use this file" }),
    );
    expect(writes().at(-1)).toEqual({
      hash: "h1",
      path: "/opt/codex2",
      stamp: "s2",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks again when the file isn't the one agreed to, and goes back to the app's own", async () => {
    view.command_to_agree = true;
    view.settings[3] = { ...view.settings[3]!, saved: "/opt/codex" };
    await open();
    expect(screen.getByText(/isn't the one you agreed to/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Look at it…" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Use the app's own" }),
    );
    expect(writes()).toEqual([{ hash: "h1", path: null }]);
  });
});
