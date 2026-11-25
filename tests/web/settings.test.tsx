// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    render(<Settings first={first} onDirtyChange={dirty} />);
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
    expect(await screen.findByText(/not set up/)).toBeTruthy();
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
