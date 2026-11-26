import { konfabHome } from "./config.js";
import {
  GithubToken,
  GithubTokenError,
  githubAccepts,
} from "./github/token-store.js";
import { askHidden, GITHUB, Keychain } from "./telegram/token.js";

/** Where the skill search's token comes from, as the page shows it. */
export type TokenSource = "environment" | "keychain" | "file" | "unavailable";

export type GithubTokenDeps = {
  home: string;
  say: (line: string) => void;
  ask: ((question: string) => Promise<string | null>) | null;
  store: GithubToken;
};

/**
 * `npm run setup -- --github-token`, with `--status` or `--remove`: the same
 * store and the same rules as the page.
 */
export async function githubTokenCommand(
  args: string[],
  deps: GithubTokenDeps,
): Promise<boolean> {
  const rest = args.filter((arg) => arg !== "--github-token");
  const known = ["--status", "--remove", "--earlier"];
  if (
    args.length - rest.length !== 1 ||
    rest.some((arg) => !known.includes(arg)) ||
    new Set(rest).size !== rest.length ||
    (rest.includes("--earlier") && !rest.includes("--remove")) ||
    (rest.includes("--status") && rest.length > 1)
  )
    throw new Error(
      "Use --github-token on its own, or with --status, --remove, or --remove --earlier.",
    );
  const { say, store } = deps;
  await store.load();
  if (rest.includes("--status")) {
    say(store.where());
    const view = store.view();
    for (const item of view.left_over)
      say(`Not used, and may still be stored: ${item}`);
    return true;
  }
  try {
    if (rest.includes("--remove")) {
      await store.remove(rest.includes("--earlier"));
      say(
        "The GitHub token isn't used any more." +
          (store.source === "environment"
            ? " KONFAB_GITHUB_TOKEN is still set, and comes first."
            : ""),
      );
      return true;
    }
    if (!deps.ask) throw new GithubTokenError("Run this in a terminal.");
    say(
      "Paste a GitHub token (it isn't shown). Konfab checks it with GitHub, then keeps it.",
    );
    const token = await deps.ask("GitHub token: ");
    if (!token) {
      say("Nothing was changed.");
      return false;
    }
    await store.store(token);
    say(`Saved. ${store.where()} In use at once.`);
    return true;
  } catch (error) {
    say(
      error instanceof GithubTokenError
        ? error.message
        : "That didn't work. Nothing was changed.",
    );
    return false;
  }
}

export async function setupGithubToken(args: string[]): Promise<boolean> {
  const home = konfabHome();
  const keychain = new Keychain(process.env, process.platform, undefined, {
    home,
    kind: GITHUB,
  });
  const person = process.stdin.isTTY && process.stdout.isTTY;
  return githubTokenCommand(args, {
    home,
    say: console.log,
    ask: person ? askHidden : null,
    store: new GithubToken({
      home,
      keychain,
      env: process.env,
      accepts: githubAccepts,
      changed: () => undefined,
    }),
  });
}
