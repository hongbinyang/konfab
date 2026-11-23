import { useCallback, useEffect, useState } from "react";
import { request } from "./api";

type View = {
  state: "not_set_up" | "off" | "on";
  chat_name: string | null;
  away_minutes: number;
  problem: string | null;
};

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

/** The lead's switch for notices through Telegram. */
export function PhoneNotices() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    request<View>("/api/phone-notices").then(setView, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!view) return null;
  const set = (enabled: boolean) => {
    setBusy(true);
    setError("");
    request<View>("/api/phone-notices", { method: "PUT", body: { enabled } })
      .then(setView, () => setError("That couldn't be changed. Try again."))
      .finally(() => setBusy(false));
  };
  return (
    <section className="phone-notices" aria-label="Phone notices">
      {view.state === "not_set_up" ? (
        <p className="muted">
          Phone notices (Telegram): not set up. Run{" "}
          <code>npm run setup -- --telegram</code>.
        </p>
      ) : (
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
    </section>
  );
}
