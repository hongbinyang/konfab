import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PhoneSwitch,
  usePhone,
  type PhoneSetupView,
  type PhoneView,
} from "./PhoneNotices";

export const REMOVE_QUESTION =
  "Remove phone notices? They stop at once, the chat is forgotten and the stored token is deleted. To end the bot itself, tell @BotFather.";
export const OLD_QUESTION =
  "Another Konfab folder of yours may use this token; its phone notices would then stop. Remove it?";

type Phone = ReturnType<typeof usePhone>;

/** In Settings: everything about the chat and the bot, but never the token. */
export function PhoneSetup() {
  const phone = usePhone();
  const { view, busy, send } = phone;
  const [asking, setAsking] = useState(false);
  const [tested, setTested] = useState(false);
  if (!view) return null;
  const setUp = view.state !== "not_set_up";
  return (
    <section className="phone-setup phone-notices" aria-label="Phone notices">
      {view.setup ? (
        <Steps phone={phone} setup={view.setup} />
      ) : (
        <>
          {!setUp && !asking && (
            <p className="muted">
              Not set up.{" "}
              <button type="button" onClick={() => setAsking(true)}>
                Set up…
              </button>
            </p>
          )}
          <PhoneSwitch phone={phone} />
          {setUp && !asking && (
            <p className="phone-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setTested(false);
                  void send("/test", {}).then(setTested);
                }}
              >
                Send a test
              </button>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => setAsking(true)}
              >
                Set up again
              </button>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(REMOVE_QUESTION)) void send("/remove", {});
                }}
              >
                Remove
              </button>
              <span className="muted" role="status">
                {tested ? "Sent “Konfab: test”." : ""}
              </span>
            </p>
          )}
          {asking && (
            <Start
              view={view}
              busy={busy}
              onCancel={() => setAsking(false)}
              onStart={(way) =>
                void send("/setup", { way }).then((started) => {
                  if (started) setAsking(false);
                })
              }
            />
          )}
        </>
      )}
      {view.left_over?.map((left) => (
        <p key={left.item} className="muted left-over">
          {left.old
            ? "An earlier token may still be in your Keychain. Another Konfab folder of yours may use it."
            : left.unsure
              ? "It isn't known whether a token that isn't used is in your Keychain."
              : "A token that isn't used may still be in your Keychain."}{" "}
          <code>{left.item}</code>{" "}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              if (left.old && !window.confirm(OLD_QUESTION)) return;
              void send("/left-over", {
                item: left.item,
                elsewhere: left.old,
              });
            }}
          >
            Remove it
          </button>
        </p>
      ))}
    </section>
  );
}

function Start({
  view,
  busy,
  onStart,
  onCancel,
}: {
  view: PhoneView;
  busy: boolean;
  onStart: (way: "terminal" | "env") => void;
  onCancel: () => void;
}) {
  const way = view.ways?.[0];
  return (
    <Card title="Set up phone notices" step={0}>
      <p>
        Konfab can tell your own Telegram chat that a room needs you while you
        are away. Notices never contain message text, files or agent names.
        Telegram carries them, so it sees them and when they are sent.
      </p>
      <p>
        First make a bot only for Konfab: in Telegram, write{" "}
        <strong>/newbot</strong> to <strong>@BotFather</strong>.
      </p>
      {way === undefined ? (
        <p>
          On this computer the bot&apos;s token comes from{" "}
          <code>KONFAB_TELEGRAM_TOKEN</code>. Set it for Konfab, from a file
          only you can read, and start Konfab again.
        </p>
      ) : (
        <p className="muted">
          {way === "env"
            ? "Konfab uses the token from KONFAB_TELEGRAM_TOKEN. "
            : "The token goes from a terminal to your Keychain, and never through this page. "}
          Konfab then contacts Telegram to check the bot.
          {view.state !== "not_set_up" &&
            " Your present setup goes on working until the last step."}
        </p>
      )}
      <div className="phone-buttons">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        {way && (
          <button type="button" disabled={busy} onClick={() => onStart(way)}>
            Start
          </button>
        )}
      </div>
    </Card>
  );
}

const STEP: Record<PhoneSetupView["step"], [number, string]> = {
  token: [1, "Your bot"],
  bot: [2, "Your chat"],
  code: [2, "Send this code from your phone"],
  chat: [3, "Is this you?"],
  test: [3, "Did the test arrive?"],
  finish: [4, "Ready"],
};

function Card({
  title,
  step,
  children,
}: {
  title: string;
  step: number;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The next step is found by keyboard and read aloud.
  useEffect(() => heading.current?.focus(), [title]);
  return (
    <div className="phone-card">
      <h3 ref={heading} tabIndex={-1}>
        {step > 0 && <span className="muted">{step} of 4 · </span>}
        {title}
      </h3>
      {step > 0 && (
        <div className="phone-steps" aria-hidden="true">
          {[1, 2, 3, 4].map((one) => (
            <i key={one} className={one <= step ? "on" : ""} />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState("");
  return (
    <p className="phone-command">
      <code>{command}</code>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(command))
            .then(
              () => setState("Copied."),
              () => setState("Couldn't copy; select it."),
            );
        }}
      >
        Copy
      </button>
      <span className="muted" role="status">
        {state}
      </span>
    </p>
  );
}

function Steps({ phone, setup }: { phone: Phone; setup: PhoneSetupView }) {
  const { busy, send } = phone;
  const [step, title] = STEP[setup.step];
  const { id } = setup;
  const off = busy || setup.busy;
  const minutes =
    setup.seconds_left === null ? null : Math.ceil(setup.seconds_left / 60);
  const button = (
    label: string,
    path: string,
    body: object = {},
    secondary = false,
  ) => (
    <button
      type="button"
      className={secondary ? "secondary" : ""}
      disabled={off}
      onClick={() => void send(`/setup/${path}`, { id, ...body })}
    >
      {label}
    </button>
  );
  return (
    <Card title={title} step={step}>
      {setup.step === "token" && (
        <>
          {setup.command && (
            <>
              <p>Run this in a terminal, in Konfab&apos;s folder:</p>
              <CopyCommand command={setup.command} />
              <p className="muted">
                macOS asks for the bot&apos;s token and keeps it in your
                Keychain. Then this page goes on by itself.
              </p>
            </>
          )}
          {setup.busy && <p className="muted">Checking the bot…</p>}
        </>
      )}
      {setup.step === "bot" && (
        <p>
          The bot is <strong>@{setup.bot}</strong>. Konfab finds your chat by a
          code that you send to it. For that it reads the messages waiting for
          the bot, which can briefly interrupt another program reading it.
        </p>
      )}
      {setup.step === "code" && (
        <>
          <p>
            In Telegram on your phone, open <strong>@{setup.bot}</strong>, press
            Start, and send exactly this:
          </p>
          <p className="phone-code">{setup.code}</p>
          <p className="muted">
            Waiting…{" "}
            <span aria-hidden="true">
              {Math.floor((setup.seconds_left ?? 0) / 60)}:
              {String((setup.seconds_left ?? 0) % 60).padStart(2, "0")} left
            </span>
            <span className="sr-only" role="status">
              {minutes === null
                ? ""
                : `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`}
            </span>
          </p>
        </>
      )}
      {setup.step === "chat" && (
        <p>
          The code came from <strong>{setup.chat_name}</strong>. A test shows
          that notices arrive there.
        </p>
      )}
      {setup.step === "test" && (
        <p>
          Konfab sent “Konfab: test” to <strong>{setup.chat_name}</strong>.
        </p>
      )}
      {setup.step === "finish" && (
        <p>
          Notices will go to <strong>{setup.chat_name}</strong>
          {setup.arrived ? "" : ", without a test"}. Until now nothing was
          changed.
        </p>
      )}
      {setup.problem && (
        <p className="attachment-error" role="alert">
          {setup.problem}
        </p>
      )}
      {phone.error && (
        <p className="attachment-error" role="alert">
          {phone.error}
        </p>
      )}
      <div className="phone-buttons">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void send("/setup/cancel", { id })}
        >
          Cancel
        </button>
        {setup.step === "token" && setup.again && button("Try again", "again")}
        {setup.step === "bot" && button("Show a code", "code")}
        {setup.step === "chat" && (
          <>
            {button("It isn't me", "confirm", { arrived: false }, true)}
            {button("Skip the test", "confirm", { arrived: true }, true)}
            {button("Send a test", "test")}
          </>
        )}
        {setup.step === "test" && (
          <>
            {button("Send again", "test", {}, true)}
            {button("No", "confirm", { arrived: false }, true)}
            {button("Yes, it arrived", "confirm", { arrived: true })}
          </>
        )}
        {setup.step === "finish" && (
          <>
            {button("Finish, off", "finish", { enabled: false }, true)}
            {button("Turn on", "finish", { enabled: true })}
          </>
        )}
      </div>
    </Card>
  );
}
