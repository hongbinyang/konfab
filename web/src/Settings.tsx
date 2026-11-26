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
    id: "approvals",
    name: "Pre-approvals",
    about:
      "What agents may send to whom without asking you, in every room. Each use is still logged. Everything else still asks.",
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
