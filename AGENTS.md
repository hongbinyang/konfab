# Working on Konfab

Conventions for AI agents (and people) changing this repo. Konfab room rules and the lead's instructions take precedence.

## Workspace

- Work in your own git worktree on your own branch, for example `git worktree add ../konfab-<you> -b feature/<topic> main`. Never switch branches or leave uncommitted changes in a checkout someone else is using.
- Branch names: `feature/<topic>` for code, `docs/<topic>` for documentation only.

## Before you commit

- `npm run check` must pass (types, lint, format, unit, integration and smoke tests).
- Behaviour that spans a server restart needs a test that really restarts the service (reopen the database, build a new service and app), not only a simulated outage.
- Never put agent or vendor names (for example Claude, Codex, Anthropic, OpenAI) in commit messages, trailers, branch names or pull requests.
- Never commit tokens, `.mcp.json` or anything from `~/.konfab/`.

## Reporting work

- Copy commit hashes from git output (`git log -1 --format=%H`); don't retype them.
- Say what you verified and how, and what you didn't verify.
- Post a design note before larger changes, and wait for review before committing.

## Pushing

- Pushes need a scoped `code_push` approval: repository, branch, and full base and head commit IDs.
- Immediately before pushing, check that `origin/<branch>` equals the approved base and your local branch equals the approved head. If anything changed, ask again.
- Push only fast-forwards. Never force-push.

## Docs

- Keep `README.md`, `docs/user-guide.md` and `REQUIREMENTS.md` in step with user-visible changes, and keep them concise.
