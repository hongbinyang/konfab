import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./api";

export type PhoneSetupView = {
  id: string;
  way: "paste" | "terminal" | "env";
  step: "token" | "bot" | "code" | "chat" | "test" | "finish";
  command: string | null;
  busy: boolean;
  again: boolean;
  bot: string | null;
  code: string | null;
  seconds_left: number | null;
  chat_name: string | null;
  arrived: boolean | null;
  problem: string | null;
};
export type PhoneView = {
  state: "not_set_up" | "off" | "on";
  chat_name: string | null;
  away_minutes: number;
  problem: string | null;
  /** Absent from older servers. */
  setup?: PhoneSetupView | null;
  ways?: ("paste" | "terminal" | "env")[];
  /** Where tokens are kept here. Absent from older servers. */
  kept?: "keychain" | "file" | null;
  left_over?: { item: string; at: number; unsure: boolean; old: boolean }[];
};

/** As the terminal says it. */
export const keptIn = (kept: PhoneView["kept"]): string =>
  kept === "file" ? "in Konfab's private token folder" : "in your Keychain";

/** Tells Konfab that someone is really using the page, at most once a minute. */
export function useActivity(): void {
  useEffect(() => {
    let last = 0;
    const active = (event: Event) => {
      // Only a person's own actions, not a script's.
      if (!event.isTrusted || Date.now() - last < 60_000) return;
      last = Date.now();
      void request("/api/activity", { method: "POST" }).catch(() => undefined);
    };
    const kinds = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const kind of kinds)
      window.addEventListener(kind, active, { capture: true, passive: true });
    return () => {
      for (const kind of kinds)
        window.removeEventListener(kind, active, { capture: true });
    };
  }, []);
}

/**
 * The lead's view of it, looked at more often while a setup is under way.
 * Answers from before a change aren't shown after it.
 */
export function usePhone() {
  const [view, setView] = useState<PhoneView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const changes = useRef(0);
  const load = useCallback(() => {
    const at = changes.current;
    request<PhoneView>("/api/phone-notices").then(
      (next) => {
        if (at === changes.current) setView(next);
      },
      () => undefined,
    );
  }, []);
  const underWay = Boolean(view?.setup);
  useEffect(() => {
    load();
    const timer = setInterval(load, underWay ? 2_000 : 60_000);
    return () => clearInterval(timer);
  }, [load, underWay]);
  const send = useCallback(
    async (path: string, body: object, method = "POST"): Promise<boolean> => {
      changes.current += 1;
      setBusy(true);
      setError("");
      try {
        const next = await request<PhoneView>(`/api/phone-notices${path}`, {
          method,
          body,
        });
        changes.current += 1;
        setView(next);
        return true;
      } catch (caught) {
        changes.current += 1;
        setError(
          caught instanceof Error ? caught.message : "That didn't work.",
        );
        load();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );
  return { view, error, busy, send };
}

type Phone = ReturnType<typeof usePhone>;

/** The lead's switch for notices through Telegram. */
export function PhoneSwitch({ phone }: { phone: Phone }) {
  const { view, error, busy, send } = phone;
  if (!view) return null;
  const set = (enabled: boolean) => void send("", { enabled }, "PUT");
  return (
    <>
      {view.state !== "not_set_up" && (
        <>
          <label>
            <input
              type="checkbox"
              checked={view.state === "on"}
              disabled={busy}
              onChange={(event) => set(event.target.checked)}
            />
            Phone notices (Telegram) to {view.chat_name}
          </label>
          <p className="muted">
            {view.state === "on"
              ? `Sent after ${view.away_minutes} minutes without activity here.`
              : "Off. Nothing is sent."}
          </p>
        </>
      )}
      {view.problem && (
        <p className="attachment-error" role="alert">
          Phone notices aren&apos;t getting through. {view.problem}{" "}
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => set(true)}
          >
            Try again
          </button>
        </p>
      )}
      {error && (
        <p className="attachment-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Under Lead, in the right panel. */
export function PhoneNotices({ onSetUp }: { onSetUp?: () => void }) {
  const phone = usePhone();
  if (!phone.view) return null;
  return (
    <section className="phone-notices" aria-label="Phone notices">
      {phone.view.state === "not_set_up" && (
        <p className="muted">
          Phone notices (Telegram): not set up.{" "}
          {phone.view.ways && onSetUp ? (
            <button type="button" className="quiet" onClick={onSetUp}>
              Set up…
            </button>
          ) : (
            <>
              Run <code>npm run setup -- --telegram</code>.
            </>
          )}
        </p>
      )}
      <PhoneSwitch phone={phone} />
    </section>
  );
}
