import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "./Modal";
import { PhoneSetup } from "./PhoneSetup";
import { request, RequestError } from "./api";

type Approval = { recipient: string; data: string };
type Value = string | number | boolean | null | number[] | Approval[];
type Setting = {
  key: string;
  section: "phone" | "rejoin" | "agents" | "approvals" | "advanced";
  name: string;
  help: string;
  control:
    | { type: "switch" }
    | {
        type: "number";
        min: number;
        max: number;
        unit?: string;
        decimal?: boolean;
      }
    | { type: "time" }
    | { type: "command" }
    | { type: "name" }
    | { type: "minutes"; max: number; most: number }
    | { type: "approvals" }
    | { type: "text" };
  effect: "now" | "next_join" | "restart" | "next_setup" | "never";
  effect_text: string;
  page: "edit" | "ask" | "later";
  saved: Value;
  in_use: Value;
  default: Value;
};
type View = {
  hash: string;
  problem: string | null;
  platform: string;
  settings: Setting[];
  command_to_agree: boolean;
  /** Absent from older servers. Never a token or a file's contents. */
  connectors?: {
    apps: {
      id: "codex" | "claude";
      name: string;
      in_config: boolean;
      state:
        | "connected"
        | "other_address"
        | "token_unknown"
        | "not_set_up"
        | "app_not_found"
        | "manual";
      path: string;
      can_undo: boolean;
      undo_note: string | null;
    }[];
    posts: string;
    posts_on: boolean | null;
  } | null;
  /** Absent from older servers. */
  login_item?: {
    available: boolean;
    file: "none" | "current" | "earlier";
    loaded: boolean;
    path: string;
  } | null;
  /** Absent from older servers. Never the token. */
  github?: {
    source: "environment" | "stored" | "earlier" | "none";
    kept: "keychain" | "file" | null;
    readable: boolean;
    earlier_left: boolean;
    left_over: string[];
  } | null;
  /** Keys in the file that nothing reads any more. Absent from older servers. */
  unused?: string[];
};

const SECTIONS = [
  {
    id: "phone",
    name: "Phone notices",
    about:
      "Short notices to your own Telegram chat while you are away from this page.",
  },
  {
    id: "rejoin",
    name: "Rejoin",
    about: "Brings agents back with one click. Experimental, macOS.",
  },
  {
    id: "agents",
    name: "Agents",
    about:
      "How agents take turns, wait and report, for all rooms. A room's own check-in, set in its Edit, comes first.",
  },
  {
    id: "connectors",
    name: "Connectors",
    about:
      "How Codex and Claude Code reach Konfab. Each change is shown first, exactly; restart the app afterwards.",
  },
  {
    id: "approvals",
    name: "Pre-approvals",
    about:
      "What agents may send to whom without asking you, in every room. Each use is still logged. Everything else still asks.",
  },
  {
    id: "github",
    name: "GitHub token",
    about:
      "Optional. The skill search works without one; with one, GitHub allows many more searches an hour.",
  },
  {
    id: "advanced",
    name: "Advanced",
    about: "The server itself. These are used after a restart of Konfab.",
  },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

/** Said before it is done; nothing is saved without a yes. */
export const QUESTIONS: Record<string, { on: string; off?: string }> = {
  "rejoin.claude_watcher": {
    on: "Claude agents are then asked, when they join, to start one small background command that wakes them. Claude may ask you to allow it. Each agent takes part from its next join: paste its rejoin prompt once. Turn it on?",
    off: "Open requests to Claude agents are closed. Commands that wait now rest and wake nobody; one that was told a moment ago can still start a short turn. Turned on again, each agent needs a join. Turn it off?",
  },
  "rejoin.enabled": {
    on: "",
    off: "Open requests are closed. A prompt that is already in Codex can still start a short turn, which is told to end. Turn it off?",
  },
  "rejoin.allow_untested_version": {
    on: "Konfab then uses Codex versions that this hasn't been tried with. A prompt could go astray. Allow it?",
  },
};

const text = (value: Value): string =>
  value === null
    ? "none"
    : value === true
      ? "on"
      : value === false
        ? "off"
        : String(value);

/** Null if it can't be saved, with a reason for the lead. */
export function fromField(
  setting: Pick<Setting, "control"> & { default?: Value },
  field: string,
): { value: Value } | { wrong: string } {
  const { control } = setting;
  const typed = field.trim();
  if (control.type === "time")
    return typed === ""
      ? { value: null }
      : /^([01]\d|2[0-3]):[0-5]\d$/.test(typed)
        ? { value: typed }
        : { wrong: "Use a time like 22:00, or leave it empty" };
  if (control.type === "number") {
    const number = Number(typed);
    const form = control.decimal ? /^\d+(\.\d+)?$/ : /^\d+$/;
    // An agent's own: empty means the default.
    if (typed === "" && setting.default === null) return { value: null };
    return form.test(typed) && number >= control.min && number <= control.max
      ? { value: number }
      : {
          wrong: `A ${control.decimal ? "number" : "whole number"} from ${control.min} to ${control.max}`,
        };
  }
  if (control.type === "minutes") {
    const parts =
      typed === "" ? [] : typed.split(",").map((part) => part.trim());
    const numbers = parts.map(Number);
    return parts.length <= control.most &&
      parts.every((part) => /^\d+$/.test(part)) &&
      numbers.every((number) => number >= 1 && number <= control.max)
      ? { value: numbers }
      : {
          wrong: `Whole minutes from 1 to ${control.max}, separated by commas, at most ${control.most}`,
        };
  }
  if (control.type === "name")
    return typed.length >= 1 && typed.length <= 60
      ? { value: typed }
      : { wrong: "A name of 1 to 60 characters" };
  return { value: typed };
}

/** What was typed, and the saved value that it was typed over. */
type Draft = { field: string; base: Value };

/** Lists are compared by what is in them. */
const same = (one: Value, other: Value) =>
  JSON.stringify(one) === JSON.stringify(other);

const toField = (value: Value) =>
  value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value);

const FIRST = { section: "phone" } as const;

export function Settings({
  at = FIRST,
  onDirtyChange,
}: {
  at?: { section: Section };
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [section, setSection] = useState<Section>(at.section);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  // Counts saves, so that an answer from before one isn't shown after it.
  const saves = useRef(0);
  const load = useCallback(() => {
    const at = saves.current;
    return request<View>("/api/settings").then(
      (next) => {
        if (at === saves.current) setView(next);
      },
      (caught: unknown) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "The settings can't be read",
        ),
    );
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => setSection(at.section), [at]);
  const changed = Object.entries(drafts).filter(([key, { field }]) => {
    const setting = view?.settings.find((item) => item.key === key);
    return setting && toField(setting.saved) !== field.trim();
  });
  const dirty = changed.length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  if (!view)
    return (
      <section className="settings">
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </section>
    );

  const save = async (
    change: { set?: Record<string, Value>; reset?: string[] },
    what: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved("");
    saves.current += 1;
    const keys = [...Object.keys(change.set ?? {}), ...(change.reset ?? [])];
    const sent = drafts;
    try {
      const send = (confirmed: string[]) =>
        request<View>("/api/settings", {
          method: "PATCH",
          body: {
            hash: view.hash,
            ...change,
            ...(confirmed.length ? { confirmed } : {}),
          },
        });
      let next: View;
      try {
        next = await send([]);
      } catch (caught) {
        // The same question as on the command line; nothing without a yes.
        if (
          !(caught instanceof RequestError) ||
          caught.code !== "settings_confirm"
        )
          throw caught;
        if (!window.confirm(caught.message)) return;
        next = await send(keys);
      }
      saves.current += 1;
      setView(next);
      // What was typed after the click stays, over the value just saved.
      setDrafts((all) =>
        Object.fromEntries(
          Object.entries(all).flatMap(([key, draft]) => {
            if (!keys.includes(key)) return [[key, draft]];
            if (draft.field === sent[key]?.field) return [];
            const base =
              change.set && key in change.set
                ? change.set[key]!
                : (view.settings.find((item) => item.key === key)?.default ??
                  null);
            return [[key, { ...draft, base }]];
          }),
        ),
      );
      setSaved(`Saved: ${what}.`);
    } catch (caught) {
      setError(
        caught instanceof RequestError && caught.code === "settings_changed"
          ? "The file has changed meanwhile. Nothing was saved; here are the values now."
          : caught instanceof Error
            ? `Not saved: ${caught.message}`
            : "Not saved.",
      );
      saves.current += 1;
      await load();
    } finally {
      setBusy(false);
    }
  };
  const off = view.problem !== null;
  const rows = view.settings.filter(
    (setting) =>
      setting.section === section &&
      setting.page !== "later" &&
      setting.control.type !== "approvals",
  );
  const approvals = view.settings.find(
    (setting) => setting.control.type === "approvals",
  );
  const here = SECTIONS.find((item) => item.id === section)!;
  /** Changed elsewhere since the lead began to type; they decide. */
  const conflicts = changed.filter(([key, { base }]) => {
    const setting = view.settings.find((item) => item.key === key)!;
    return !same(setting.saved, base);
  });
  const wrong = changed.filter(([key, { field }]) => {
    const setting = view.settings.find((item) => item.key === key)!;
    return "wrong" in fromField(setting, field);
  });
  const mine = changed.filter(([key]) => rows.some((row) => row.key === key));

  return (
    <section className="settings" aria-label="Settings">
      <nav aria-label="Settings sections">
        <h2>Settings</h2>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === section ? "on" : ""}
            aria-current={item.id === section ? "page" : undefined}
            onClick={() => setSection(item.id)}
          >
            {item.name}
          </button>
        ))}
        <p className="muted">
          Also on the command line: <code>npm run config</code>
        </p>
      </nav>
      <div className="settings-main">
        <h2>{here.name}</h2>
        <p className="muted">{here.about}</p>
        {view.problem && (
          <p className="settings-problem" role="alert">
            {view.problem}. The earlier values are in use, and nothing can be
            saved here until the file is right.
          </p>
        )}
        {error && (
          <p className="settings-problem" role="alert">
            {error}
          </p>
        )}
        <p className="sr-only" role="status">
          {saved}
        </p>
        {section === "phone" && <PhoneSetup />}
        {section === "connectors" && view.connectors && (
          <ConnectorsPart
            view={view}
            off={off}
            onSaved={(next, what) => {
              saves.current += 1;
              setView(next);
              setSaved(what);
            }}
          />
        )}
        {section === "github" && view.github && (
          <GithubToken
            github={view.github}
            off={off}
            onSaved={(next, what) => {
              saves.current += 1;
              setView(next);
              setSaved(what);
            }}
          />
        )}
        {section === "advanced" && view.login_item && (
          <LoginItemRow
            item={view.login_item}
            off={off}
            onSaved={(next, what) => {
              saves.current += 1;
              setView(next);
              setSaved(what);
            }}
          />
        )}
        {section === "advanced" && (view.unused?.length ?? 0) > 0 && (
          <p className="settings-unused">
            Not read by this version, in your file:{" "}
            <code>{view.unused!.join(", ")}</code>.{" "}
            <button
              type="button"
              className="link"
              disabled={off || busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Remove ${view.unused!.join(", ")} from config.yaml? This version doesn't read them; older versions used some of them, and a newer one or another program might. A copy of the file is kept in backups/config.`,
                  )
                )
                  return;
                setBusy(true);
                void request<View>("/api/settings/clean", {
                  method: "POST",
                  body: { hash: view.hash, keys: view.unused },
                })
                  .then(
                    (next) => {
                      saves.current += 1;
                      setView(next);
                      setSaved("Removed what isn't used any more.");
                    },
                    (caught: unknown) => {
                      setError(
                        caught instanceof RequestError &&
                          caught.code === "settings_changed"
                          ? "The file has changed meanwhile. Nothing was removed; here is what is in it now."
                          : caught instanceof Error
                            ? `Not removed: ${caught.message}`
                            : "Not removed.",
                      );
                      saves.current += 1;
                      void load();
                    },
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Remove them
            </button>
          </p>
        )}
        {section === "approvals" && approvals && (
          <Approvals
            list={(approvals.saved ?? []) as Approval[]}
            off={off}
            onSaved={(next, what) => {
              saves.current += 1;
              setView(next);
              setSaved(what);
            }}
          />
        )}
        {rows.map((setting) => (
          <Row
            key={setting.key}
            setting={setting}
            off={off}
            busy={busy}
            draft={drafts[setting.key]?.field}
            conflict={conflicts.some(([key]) => key === setting.key)}
            onDraft={(field) =>
              setDrafts((all) => ({
                ...all,
                [setting.key]: {
                  field,
                  // A field that shows the saved value starts from it anew.
                  base:
                    all[setting.key] &&
                    all[setting.key]!.field.trim() !== toField(setting.saved)
                      ? all[setting.key]!.base
                      : setting.saved,
                },
              }))
            }
            onMine={() =>
              setDrafts((all) => ({
                ...all,
                [setting.key]: { ...all[setting.key]!, base: setting.saved },
              }))
            }
            onTheirs={() =>
              setDrafts((all) =>
                Object.fromEntries(
                  Object.entries(all).filter(([key]) => key !== setting.key),
                ),
              )
            }
            onSwitch={(on) => {
              const asks = QUESTIONS[setting.key]?.[on ? "on" : "off"];
              if (asks && !window.confirm(asks)) return;
              void save(
                { set: { [setting.key]: on } },
                `${setting.name}, ${on ? "on" : "off"}`,
              );
            }}
            onReset={() => {
              const asks =
                typeof setting.default === "boolean"
                  ? QUESTIONS[setting.key]?.[setting.default ? "on" : "off"]
                  : "";
              if (asks && !window.confirm(asks)) return;
              void save(
                { reset: [setting.key] },
                `${setting.name}, ${text(setting.default)}`,
              );
            }}
            command={
              setting.control.type === "command" ? (
                <CommandSteps
                  view={view}
                  value={setting.saved as string | null}
                  off={off}
                  onSaved={(next) => {
                    setView(next);
                    setSaved(`Saved: ${setting.name}.`);
                  }}
                />
              ) : null
            }
          />
        ))}
        {mine.length > 0 && (
          <div className="settings-bar">
            <span>
              {mine.length === 1 ? "1 change" : `${mine.length} changes`}:{" "}
              {mine
                .map(([key, { field }]) => {
                  const setting = rows.find((row) => row.key === key)!;
                  return `${setting.name}, ${text(setting.saved)} → ${field.trim() || "none"}`;
                })
                .join(" · ")}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setDrafts((all) =>
                  Object.fromEntries(
                    Object.entries(all).filter(
                      ([key]) => !mine.some(([own]) => own === key),
                    ),
                  ),
                )
              }
            >
              Discard
            </button>
            <button
              type="button"
              disabled={
                off ||
                [...wrong, ...conflicts].some(([key]) =>
                  mine.some(([own]) => own === key),
                )
              }
              aria-disabled={busy}
              onClick={() => {
                const set: Record<string, Value> = {};
                const reset: string[] = [];
                for (const [key, { field }] of mine) {
                  const setting = rows.find((row) => row.key === key)!;
                  const read = fromField(setting, field);
                  if (!("value" in read)) continue;
                  // Empty: an agent's own is taken away, and the default counts.
                  if (read.value === null && setting.default === null)
                    reset.push(key);
                  else set[key] = read.value;
                }
                void save(
                  { set, ...(reset.length ? { reset } : {}) },
                  mine
                    .map(([key]) => rows.find((row) => row.key === key)!.name)
                    .join(", "),
                );
              }}
            >
              Save
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Row({
  setting,
  off,
  busy,
  draft,
  conflict,
  onDraft,
  onMine,
  onTheirs,
  onSwitch,
  onReset,
  command,
}: {
  setting: Setting;
  off: boolean;
  busy: boolean;
  draft: string | undefined;
  conflict: boolean;
  onMine: () => void;
  onTheirs: () => void;
  onDraft: (field: string) => void;
  onSwitch: (on: boolean) => void;
  onReset: () => void;
  command: ReactNode;
}) {
  const id = useId();
  const { control } = setting;
  const field = draft ?? toField(setting.saved);
  const read = fromField(setting, field);
  const wrong = draft !== undefined && "wrong" in read ? read.wrong : "";
  const differs = !same(setting.saved, setting.in_use);
  return (
    <div className="setting">
      <div className="setting-text">
        {command ? (
          <span className="name">{setting.name}</span>
        ) : (
          <label htmlFor={id}>{setting.name}</label>
        )}
        <p id={`${id}-help`} className="muted">
          {setting.help}.{" "}
          {setting.effect !== "now" && (
            <span className="effect">{setting.effect_text}.</span>
          )}
        </p>
        {differs && (
          <p className="warning-text">
            Saved: {text(setting.saved)}. In use: {text(setting.in_use)}
            {setting.effect === "restart" ? " until Konfab restarts" : ""}.
          </p>
        )}
        {wrong && (
          <p className="attachment-error" role="alert">
            {wrong}
          </p>
        )}
        {conflict && (
          <p className="warning-text" role="alert">
            Changed elsewhere to {text(setting.saved)} while you typed.{" "}
            <button type="button" className="link" onClick={onMine}>
              Keep mine ({draft?.trim() || "none"})
            </button>{" "}
            <button type="button" className="link" onClick={onTheirs}>
              Use {text(setting.saved)}
            </button>
          </p>
        )}
      </div>
      <div className="setting-control">
        {command ??
          (control.type === "switch" ? (
            <input
              id={id}
              type="checkbox"
              role="switch"
              className="switch"
              checked={setting.saved === true}
              disabled={off}
              aria-disabled={busy}
              aria-describedby={`${id}-help`}
              onChange={(event) => onSwitch(event.target.checked)}
            />
          ) : (
            <>
              <input
                id={id}
                type={control.type === "time" ? "time" : "text"}
                inputMode={control.type === "number" ? "numeric" : undefined}
                value={field}
                disabled={off}
                aria-invalid={wrong ? true : undefined}
                aria-describedby={`${id}-help`}
                onChange={(event) => onDraft(event.target.value)}
              />
              {control.type === "number" && control.unit && (
                <span className="muted">{control.unit}</span>
              )}
            </>
          ))}
        {!command &&
          !same(setting.saved, setting.default) &&
          draft === undefined && (
            <button
              type="button"
              className="link"
              disabled={off}
              aria-disabled={busy}
              aria-label={`Reset ${setting.name}`}
              title={`Default: ${text(setting.default)}`}
              onClick={onReset}
            >
              Reset
            </button>
          )}
      </div>
    </div>
  );
}

/** For the next login only; the running Konfab stays unless the lead says. */
function LoginItemRow({
  item,
  off,
  onSaved,
}: {
  item: NonNullable<View["login_item"]>;
  off: boolean;
  onSaved: (view: View, what: string) => void;
}) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (body: { on: boolean; unload?: boolean }, what: string) => {
    setBusy(true);
    setProblem("");
    void request<View>("/api/settings/login-item", { method: "POST", body })
      .then(
        (next) => onSaved(next, what),
        (caught: unknown) =>
          setProblem(caught instanceof Error ? caught.message : "Not saved."),
      )
      .finally(() => setBusy(false));
  };
  const on = item.file !== "none";
  const state = !item.available
    ? "Not available here; start Konfab with your own service manager."
    : item.file === "current"
      ? "On: Konfab starts when you log in."
      : item.file === "earlier"
        ? "On, set up by an earlier version: Turn on writes this version's."
        : "Off.";
  return (
    <div className="setting">
      <div className="setting-text">
        <span className="name">Start at login</span>
        <p className="muted">
          {state}
          {item.loaded &&
            " It is loaded in macOS now, and stays so until you log out."}
        </p>
        {problem && (
          <p className="attachment-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      {item.available && (
        <div className="setting-control">
          {item.file !== "current" && (
            <button
              type="button"
              className="secondary"
              disabled={off || busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Konfab then starts when you log in, with this folder and this Node. It isn't started now, because it is already running. Turn it on?",
                  )
                )
                  send({ on: true }, "Start at login: on.");
              }}
            >
              Turn on…
            </button>
          )}
          {on && (
            <button
              type="button"
              className="link"
              disabled={off || busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Konfab then doesn't start at the next login. It keeps running now until you quit it. Turn it off?",
                  )
                )
                  return;
                const unload =
                  item.loaded &&
                  window.confirm(
                    "Also unload it now? That ends the Konfab that macOS started, and this page with it. Cancel keeps it running until you quit or log out.",
                  );
                send(
                  { on: false, unload },
                  unload
                    ? "Start at login: off. Konfab ends now."
                    : "Start at login: off.",
                );
              }}
            >
              Turn off…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const STATES = {
  connected: "Connected.",
  other_address:
    "Set up for another address or Node; Repair points it at this Konfab.",
  token_unknown:
    "Its token isn't this Konfab's (another folder, or an old token). Repair gives it a new one.",
  not_set_up: "Not set up.",
  app_not_found: "Not found here. Start the app once, then set it up.",
  manual:
    "Setup is manual: `npm run setup` writes the entries to ~/.konfab/app-setup.md.",
} as const;

type Operation =
  | { kind: "setup" | "token" | "undo"; app: "codex" | "claude" }
  | { kind: "posts"; on: boolean };
type ConnectorPreview = {
  id: string;
  files: { path: string; lines: string[] }[];
  notes: string[];
};

/** Other programs' files: shown first, exactly, and changed only on Apply. */
function ConnectorsPart({
  view,
  off,
  onSaved,
}: {
  view: View;
  off: boolean;
  onSaved: (view: View, what: string) => void;
}) {
  const connectors = view.connectors!;
  const [preview, setPreview] = useState<ConnectorPreview | null>(null);
  const [problem, setProblem] = useState("");
  const [said, setSaid] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(step: () => Promise<T>) => {
    setBusy(true);
    setProblem("");
    try {
      return await step();
    } catch (caught) {
      setProblem(
        caught instanceof Error ? caught.message : "That didn't work.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const show = (operation: Operation) =>
    void run(async () => {
      setSaid([]);
      setPreview(
        await request<ConnectorPreview>("/api/settings/connectors/preview", {
          method: "POST",
          body: { operation },
        }),
      );
    });
  const apply = () =>
    void run(async () => {
      const done = await request<View & { said: string[] }>(
        "/api/settings/connectors/apply",
        { method: "POST", body: { id: preview!.id } },
      );
      setPreview(null);
      setSaid(done.said);
      onSaved(done, done.said.join(" "));
    }).then((done) => {
      // Refused: the preview is old; it is shown again from the start.
      if (done === null) setPreview(null);
    });
  const inConfig = (app: "codex" | "claude", add: boolean, name: string) => {
    if (
      !add &&
      !window.confirm(
        `Remove ${name} from Konfab? Konfab then doesn't make its agent at the start; its agents' history stays, and its connector stays in the app until you remove it there.`,
      )
    )
      return;
    void run(async () =>
      onSaved(
        await request<View>("/api/settings/apps", {
          method: "POST",
          body: { app, add, hash: view.hash },
        }),
        `${add ? "Added" : "Removed"}: ${name}.`,
      ),
    );
  };
  const lock = off || busy || preview !== null;
  return (
    <div className="connectors">
      {connectors.apps.map((app) => (
        <div key={app.id} className="setting connector">
          <div className="setting-text">
            <span className="name">{app.name}</span>
            <p className="muted">
              {app.in_config
                ? STATES[app.state]
                : "Not in Konfab: no agent is made for it."}{" "}
              <code>{app.path}</code>
            </p>
            {app.undo_note && <p className="muted">{app.undo_note}</p>}
          </div>
          <div className="setting-control connector-actions">
            {app.in_config &&
              app.state !== "manual" &&
              app.state !== "app_not_found" && (
                <>
                  {app.state !== "connected" && (
                    <button
                      type="button"
                      disabled={lock}
                      onClick={() => show({ kind: "setup", app: app.id })}
                    >
                      {app.state === "not_set_up" ? "Set up…" : "Repair…"}
                    </button>
                  )}
                  {app.state === "connected" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={lock}
                      onClick={() => show({ kind: "token", app: app.id })}
                    >
                      New token…
                    </button>
                  )}
                  {app.can_undo && (
                    <button
                      type="button"
                      className="link"
                      disabled={lock}
                      onClick={() => show({ kind: "undo", app: app.id })}
                    >
                      Undo…
                    </button>
                  )}
                </>
              )}
            <button
              type="button"
              className="link"
              disabled={lock}
              onClick={() => inConfig(app.id, !app.in_config, app.name)}
            >
              {app.in_config ? "Remove from Konfab" : "Add to Konfab"}
            </button>
          </div>
        </div>
      ))}
      <div className="setting">
        <div className="setting-text">
          <span className="name">Codex posts without asking</span>
          <p className="muted">{connectors.posts}</p>
        </div>
        <div className="setting-control">
          {connectors.posts_on !== null && (
            <button
              type="button"
              className="secondary"
              disabled={lock}
              onClick={() => show({ kind: "posts", on: !connectors.posts_on })}
            >
              {connectors.posts_on ? "Ask again…" : "Allow…"}
            </button>
          )}
        </div>
      </div>
      {preview && (
        <div
          className="connector-preview"
          role="region"
          aria-label="What changes"
        >
          <h3>What changes</h3>
          {preview.files.map((file) => (
            <div key={file.path}>
              <code>{file.path}</code>
              <ul>
                {file.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
          {preview.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}
          <p className="muted">
            A copy of each file is kept beside it. Nothing changes until you
            apply.
          </p>
          <div className="phone-buttons">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
            <button type="button" disabled={busy || off} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
      {said.length > 0 && <p role="status">{said.join(" ")}</p>}
      {problem && (
        <p className="attachment-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The token is sent once, and the field is emptied at once. */
function GithubToken({
  github,
  off,
  onSaved,
}: {
  github: NonNullable<View["github"]>;
  off: boolean;
  onSaved: (view: View, what: string) => void;
}) {
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const kept =
    github.kept === "file" ? "Konfab's private token folder" : "your Keychain";
  const send = async (path: string, body: object, what: string) => {
    setBusy(true);
    setProblem("");
    try {
      onSaved(
        await request<View>(`/api/settings/github-token${path}`, {
          method: "POST",
          body,
        }),
        what,
      );
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  };
  const state =
    github.source === "environment"
      ? "In use: from KONFAB_GITHUB_TOKEN, which comes first. Change it there."
      : github.source === "stored"
        ? `In use: stored in ${kept}.`
        : github.source === "earlier"
          ? "In use: stored in your Keychain by an earlier version."
          : "None. The skill search works without one.";
  return (
    <div className="github-token">
      <p>
        {state}
        {!github.readable &&
          " It couldn't be read the last time; the one read before is used."}
      </p>
      {github.source !== "environment" && github.kept && (
        <form
          className="phone-paste"
          onSubmit={(event) => {
            event.preventDefault();
            const typed = token;
            setToken("");
            void send("", { token: typed }, "Saved: GitHub token.");
          }}
        >
          <label>
            {github.source === "none"
              ? "A GitHub token"
              : "Another GitHub token"}
            <input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="submit" disabled={off || busy || !token.trim()}>
            Check and save
          </button>
        </form>
      )}
      <p className="muted">
        Konfab asks GitHub whether the token works, then keeps it in {kept}
        {github.kept === "keychain"
          ? "; macOS may ask for your keychain password"
          : ""}
        . It is used at once, and never shown again.
      </p>
      {(github.source === "stored" || github.source === "earlier") && (
        <p>
          <button
            type="button"
            className="link"
            disabled={off || busy}
            onClick={() =>
              void send(
                "/remove",
                {
                  earlier:
                    github.source === "earlier" &&
                    window.confirm(
                      "Also delete it from your Keychain? Another Konfab folder of yours may use it. Cancel keeps it there, unused.",
                    ),
                },
                "Removed: GitHub token.",
              )
            }
          >
            Remove
          </button>
        </p>
      )}
      {github.earlier_left && github.source !== "earlier" && (
        <p className="muted">
          An earlier token may still be in your Keychain (
          <code>konfab-github-token</code>); it isn't used.{" "}
          <button
            type="button"
            className="link"
            disabled={off || busy}
            onClick={() => {
              if (
                window.confirm(
                  "Delete the earlier token from your Keychain? Another Konfab folder of yours may use it.",
                )
              )
                void send("/remove-earlier", {}, "Removed the earlier token.");
            }}
          >
            Remove it
          </button>
        </p>
      )}
      {github.left_over.length > 0 && (
        <p className="muted">
          Not used, and may still be stored:{" "}
          <code>{github.left_over.join(", ")}</code>
        </p>
      )}
      {problem && (
        <p className="attachment-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** One entry at a time: an Add after its question, a Remove at once. */
function Approvals({
  list,
  off,
  onSaved,
}: {
  list: Approval[];
  off: boolean;
  onSaved: (view: View, what: string) => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [data, setData] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (approval: Approval, add: boolean) => {
    setBusy(true);
    setProblem("");
    const post = (confirmed: boolean) =>
      request<View>("/api/settings/pre-approvals", {
        method: "POST",
        body: { ...approval, add, confirmed },
      });
    try {
      let next: View;
      try {
        next = await post(false);
      } catch (caught) {
        if (
          !(caught instanceof RequestError) ||
          caught.code !== "settings_confirm"
        )
          throw caught;
        if (!window.confirm(caught.message)) return false;
        next = await post(true);
      }
      onSaved(
        next,
        `${add ? "Added" : "Removed"}: ${approval.data} to ${approval.recipient}.`,
      );
      return true;
    } catch (caught) {
      setProblem(
        caught instanceof Error ? `Not saved: ${caught.message}` : "Not saved.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approvals">
      {list.length === 0 ? (
        <p className="muted">None. Agents ask you each time.</p>
      ) : (
        <ul>
          {list.map((one) => (
            <li key={`${one.recipient}\n${one.data}`}>
              <span>
                <code>{one.data}</code> to <code>{one.recipient}</code>
              </span>
              <button
                type="button"
                className="link"
                disabled={off || busy}
                aria-label={`Remove ${one.data} to ${one.recipient}`}
                onClick={() => void send(one, false)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="approvals-add"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ recipient, data }, true).then((done) => {
            if (done) {
              setRecipient("");
              setData("");
            }
          });
        }}
      >
        <label>
          Kind of data
          <input
            value={data}
            placeholder="code_push"
            maxLength={200}
            onChange={(event) => setData(event.target.value)}
          />
        </label>
        <label>
          Recipient
          <input
            value={recipient}
            placeholder="github.com/OWNER/REPO"
            maxLength={200}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={off || busy || !recipient.trim() || !data.trim()}
        >
          Add…
        </button>
      </form>
      {problem && (
        <p className="attachment-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

type Look =
  | { ok: true; path: string; stamp: string; signed_by: string | null }
  | { ok: false; reason: string };

/** Nothing of it runs before the lead's yes to exactly this file. */
function CommandSteps({
  view,
  value,
  off,
  onSaved,
}: {
  view: View;
  value: string | null;
  off: boolean;
  onSaved: (view: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  /** The saved value that the lead saw when they began. */
  const [base, setBase] = useState<string | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // An answer counts only for the dialog and the path it was asked for.
  const asked = useRef(0);
  const run = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    void action()
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Not saved"),
      )
      .finally(() => setBusy(false));
  };
  const moved = open && base !== value;
  const send = (body: object) =>
    run(async () => {
      const mine = asked.current;
      setSending(true);
      try {
        onSaved(
          await request<View>("/api/settings/codex-command", {
            method: "POST",
            body: { hash: view.hash, ...body },
          }),
        );
        if (mine === asked.current) setOpen(false);
      } finally {
        setSending(false);
      }
    });
  return (
    <>
      {view.command_to_agree && (
        <p className="warning-text">
          The file isn&apos;t the one you agreed to. Rejoin doesn&apos;t use it.
        </p>
      )}
      <span className="muted command">{value ?? "The app's own copy"}</span>
      <button
        type="button"
        className="secondary"
        disabled={off}
        onClick={() => {
          setPath(value ?? "");
          asked.current += 1;
          setBase(value);
          setLook(null);
          setError("");
          setOpen(true);
        }}
      >
        {view.command_to_agree ? "Look at it…" : "Change…"}
      </button>
      {open && (
        <Modal
          title="Codex command"
          onClose={() => setOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              {value !== null && (
                <button
                  type="button"
                  className="secondary"
                  disabled={moved}
                  aria-disabled={busy}
                  onClick={() => send({ path: null })}
                >
                  Use the app&apos;s own
                </button>
              )}
              {look?.ok ? (
                <button
                  type="button"
                  disabled={moved}
                  aria-disabled={busy}
                  onClick={() => send({ path: look.path, stamp: look.stamp })}
                >
                  Use this file
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!path.trim()}
                  aria-disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const mine = asked.current;
                      const seen = await request<Look>(
                        "/api/settings/codex-command/look",
                        { method: "POST", body: { path: path.trim() } },
                      );
                      if (mine === asked.current) setLook(seen);
                    })
                  }
                >
                  Look at it
                </button>
              )}
            </>
          }
        >
          <label>
            Absolute path{" "}
            <input
              value={path}
              // What is being saved can't be another one meanwhile.
              readOnly={sending}
              onChange={(event) => {
                asked.current += 1;
                setPath(event.target.value);
                setLook(null);
              }}
            />
          </label>
          {moved && (
            <p className="warning-text" role="alert">
              Changed elsewhere to {value ?? "the app's own copy"} meanwhile.{" "}
              <button
                type="button"
                className="link"
                onClick={() => setBase(value)}
              >
                Go on
              </button>
            </p>
          )}
          <div role="status">
            {look &&
              (look.ok ? (
                <>
                  <p>
                    Konfab will run <code>{look.path}</code> as you.
                  </p>
                  <p>
                    {look.signed_by
                      ? `It says it is signed by ${look.signed_by}. That is something to go by, not a guarantee.`
                      : "It isn't signed, as far as can be seen."}
                  </p>
                </>
              ) : (
                <p>It can&apos;t be used: {look.reason}.</p>
              ))}
          </div>
          {!look && (
            <p className="muted">
              Konfab first only looks at the file. It doesn&apos;t run it before
              you say yes.
            </p>
          )}
          {error && (
            <p className="attachment-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
