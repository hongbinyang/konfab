# Connector setup: design and spike

Status: proposal for review; no user configuration has been changed. The goal is the same default user-level setup for both desktop clients, with a configurable manual mode and no launch-pad selection.

## Evidence and limits

- The installed Claude Code CLI is 2.1.220. With `CLAUDE_CONFIG_DIR` set to a fresh temporary directory, `claude mcp add --scope user` created an entry in that directory's `.claude.json`; `claude mcp get` reported user scope. The command used a synthetic token and `/usr/bin/true`, so its connection failed as expected. This verifies the local CLI's config mechanism, not an actual desktop connection.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) says user-scoped servers live in `~/.claude.json`. The [desktop documentation](https://code.claude.com/docs/en/desktop) says local Code sessions share that configuration. Chat and Code also have distinct configuration surfaces and precedence; check all relevant duplicate definitions before claiming which one wins. Desktop operation on this machine remains to be verified with a real connector after user approval.
- Current setup only creates tokens when absent, or on `--rotate`, and writes secret snippets to `app-setup.md`. The database stores a token verifier rather than recoverable plaintext, so a previously issued token cannot simply be reinstalled from the DB. Migration must not silently revoke a working token.

## Proposed flow

`npm run setup` defaults to user-level installation for the two known clients. A setting in Konfab config and `--manual` preserve snippet-only operation. Do not touch unrelated agent entries. Setup reports each client as installed, unchanged, conflict, or needs action, without printing credentials. On first install create separate tokens per agent; a rerun preserves existing credentials and performs no writes when configurations already match.

For existing users, first look for a matching existing client entry and reuse its token only after verifying it against the database without exposing it. If no matching recoverable credential is available, offer an explicit rotation/recovery path, with a clear warning that existing bridges stop working. Never rotate as a side effect of an ordinary rerun. Make `--rotate` stage both client entries and token updates as one recoverable operation: validate inputs and writable targets first, keep old credentials usable on failure, and explain any required reload. Treat interruption and partial writes as first-class recovery cases.

## Safe configuration edits

- Claude: use the supported user-scope location and preserve unrelated top-level and server entries. Avoid passing tokens through command-line arguments, process listings or logs; use an atomic JSON edit with documented schema, or a safe supported input mechanism if available. Respect `CLAUDE_CONFIG_DIR` when configured. Preserve unknown fields and reject malformed or ambiguous config without overwriting it.
- Codex: parse TOML with a maintained, compatible parser/editor that preserves unrelated content, comments, and table semantics. Update only `mcp_servers.konfab` and its environment. Detect inline-table, dotted-key, quoted-key and duplicate-definition cases; fail safely rather than append a conflicting table. Evaluate the editor before choosing it; no parser dependency is installed today.
- Before changing an existing file create a unique, restricted-permission backup; credentials in backups are still secrets. Stage writes in the same directory with restrictive modes, validate the result, atomically replace, and avoid following unexpected symlinks. Preserve existing permissions where safe. Report backup locations and a retention/removal policy. Skip backup and write altogether when unchanged. Detect concurrent modification before replacing.

## Migration

Do not recursively scan the whole home directory or delete a folder. Discover old entries only in explicitly configured, recently recorded, or user-supplied project paths; state clearly that discovery is incomplete. Show paths and conflict/precedence information without revealing tokens. Existing project entries stay in place during initial setup. After user-level registration, reload and verify the actual desktop connection, then explicitly migrate selected known paths. Back up each `.mcp.json`, remove only its `konfab` entry, and preserve every other field; if empty, retain the empty config rather than deleting the file. Abort on concurrent changes or malformed JSON. The sandbox project stays untouched. Document the difference between Code and chat surfaces and the precise recovery procedure.

## Verification plan

Use injected temporary home/config roots and fake tokens, never real credentials: fresh and repeated setup; pre-existing unrelated entries/comments; alternate TOML forms; malformed files; permissions and symlinks; partial failures, interruption, concurrent edits and backup recovery; rotation with old bridges and rollback; custom config dirs; manual mode; explicit migration of multiple projects; no accidental discovery outside roots; and DB reopen after credential changes. Separately test an actual desktop local session in a neutral folder, with explicit permission before any changes to the real user configs, then verify a joined session before migration. Update README, user guide and requirements together. Review this design before implementation.
