# Local, open-source tools that put multiple AI coding agents in a shared chat

Researched 2026-11-06. All GitHub statistics were read from the GitHub API on 2026-11-06.

Evidence labels used below:
- **[Verified]**: seen directly in a repo, README, docs, issue, or registry. Says what the project documents, not that I ran it. None of these tools was installed or run for this research.
- **[Author claim]**: stated by the project's author and not independently confirmed.
- **[Inference]**: my reasoning, listed only under Inferences.

## Can each tool be used directly on a MacBook Pro for a Slack-like, multi-room chat among the user, Claude, and Codex?

### Takeaway
No tool meets the full brief off the shelf, and none documents the Codex desktop app or a no-CLI setup with automatic wake. The closest are crewchat (live chat page with direct agent talk, but one chat per project folder and Codex untested by the author), Maestro (mature app with multiple group chats, but CLI-driven and moderator-relayed), and walkie-talkie (the only one with real channels and a human dashboard, but no documented Codex support and idle since March 2026).

### Cited Findings

Verdict table. "Pref." means the user's stated preference of no model API and no model CLI.

| Tool | Satisfies Pref.? | Claude + Codex? | Human chat UI | Multiple rooms | Agents talk directly | Direct-use verdict |
|---|---|---|---|---|---|---|
| crewchat | Partly. No API. Wake needs CLI-style hooks; desktop clients are poll-only | Yes on paper; Codex CLI not hand-tested | Web page | One chat per folder (tabs) | Yes | Closest for direct talk; rooms only by folder workaround |
| walkie-talkie | Unproven. No API. Documented for Claude Code and Cursor only | Codex undocumented | Web dashboard | Yes, channels | Yes | Best room model; stale, Codex unproven |
| claude-slack | Fails for Codex. Claude Code only | No | Example client code only | Yes, channels | Yes, pull-based | Not suitable |
| tyolab/parley | Unproven. No API. Stop-hook is Claude Code only | Codex undocumented | CLI only | Yes, named rooms | Yes | Too young; no UI |
| parley-cli | Partly. No API. Wake depends on CLI launch flags | Yes, first-class CLI support | CLI only | Yes, channels | Yes | Solid protocol, not a chat app |
| Palaver | Fails. Requires provider API keys | Not the real agents | Web page | Yes | Yes | Not suitable |
| AgentPipe | Fails. Requires model CLIs | Yes, via CLIs | Terminal TUI | One room per run | Yes, turn-based | Not suitable for persistent rooms |
| Maestro | Fails. Requires model CLIs | Yes, via CLIs | Desktop app | Multiple group chats | No, moderator relays | Most mature; different interaction model |

Existence and identity:
- All eight tools exist. **[Verified]** "crewchat" is a name collision on GitHub. The relevant one is [deepankar17/crewchat](https://github.com/deepankar17/crewchat); other repos with that name are unrelated, for example [mattboy9921/CrewChat](https://github.com/mattboy9921/CrewChat), a general chat plugin.
- "parley" is also a collision. [tyolab/parley](https://github.com/tyolab/parley) installs from PyPI as `parley-agents`, while [parley-cli on NuGet](https://www.nuget.org/packages/parley-cli) is a separate project, [zerotomvp/parley-cli](https://github.com/zerotomvp/parley-cli). The `parley` name on PyPI is an unrelated [actor runtime library](https://pypi.org/project/parley/). **[Verified]**

### Inferences
- If the user accepts a model CLI, crewchat is the shortest path to try first, and Maestro is the safer pick if durability matters more than direct agent-to-agent talk.
- If the user holds firmly to "no CLI and automatic wake", none of these replaces building something, because the blocker is that the desktop apps have no documented way to be woken by an MCP server.
- Rooms in crewchat could be approximated with one folder per room, but that ties each room to a working directory and an agent session, which is not the Slack model.

### Gaps
- None of these tools was run on the Mac, so all functional statements rest on documentation.

## How do agents connect, and can the Claude and Codex desktop apps participate without a model CLI?

### Takeaway
Only crewchat documents a Claude Desktop path, and it is poll-only. No tool's docs that I read mention the Codex desktop app. MCP-based tools could reach it in principle because it shares MCP config with the CLI, but that is untested and wake is undocumented.

### Cited Findings
Platform facts:
- **[Verified]** OpenAI's docs say the ChatGPT desktop app, Codex CLI, and IDE extension share MCP configuration, in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`, over stdio or streamable HTTP. The page says nothing about MCP servers pushing to or waking a thread. — [OpenAI MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- **[Verified on this Mac]** `/Applications/ChatGPT.app` matches bundle ID `com.openai.codex` (version 26.1007.71326) and contains a `Contents/Resources/codex-cli` directory. `codex` also exists at `~/.local/bin/codex` and `claude` at `/opt/homebrew/bin/claude`. I checked paths only and did not run them. There is no web source for this; it comes from a local `mdfind` and `ls`.
- **[Verified]** Anthropic's desktop docs say local Code-tab sessions read `~/.claude/settings.json` and `~/.claude/skills/`, and reference `claude_desktop_config.json` for MCP servers. The portion I read does not state whether hooks are shared. — [Claude Code desktop docs](https://code.claude.com/docs/en/desktop)

By tool:
- **crewchat [Verified]**: MCP server plus hooks, set up for Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, and OpenCode. Other MCP clients can use Streamable HTTP with a bearer token. Claude Desktop connects through `crewchat stdio` in `claude_desktop_config.json`, with "no hooks", so it must check `hub_inbox` itself. — [README](https://github.com/deepankar17/crewchat). The Codex desktop app is not mentioned in the README or in the docs I searched. Codex CLI setup writes its server and hooks to `~/.codex/config.toml`. — [Getting started](https://github.com/deepankar17/crewchat/blob/HEAD/docs/getting-started.md)
- **walkie-talkie [Verified]**: a stdio MCP server connects each agent to a local HTTP Hub. Documented clients are Claude Code and Cursor. Cursor needs an experimental shell-script workaround for waiting. — [README](https://github.com/suruseas/walkie-talkie). A GitHub code search for "codex" in the repo returned 0 hits (the search index may be incomplete). Claude Desktop is not documented.
- **claude-slack [Verified]**: MCP tools for Claude Code, registered by a SessionStart hook. Agent config lives in Claude Code frontmatter. "Cross-platform agent adapters" is listed as a wanted contribution, so other agents are not supported. — [README](https://github.com/theo-nash/claude-slack)
- **tyolab/parley [Verified]**: FastAPI gateway with REST and an MCP endpoint. `parley init` and `parley enroll` write to `~/.claude.json`, and the docs say "any MCP-capable agent" can join. Codex is not named in the README. — [README](https://github.com/tyolab/parley)
- **parley-cli [Verified]**: agents run a shell command against a shared JSONL store. It works with any agent that can invoke a CLI and share `PARLEY_HOME`. Codex CLI 0.147.0 and Claude Code 2.1.226 are first-class tested versions. — [README](https://github.com/zerotomvp/parley-cli)
- **Palaver [Verified]**: agents are defined inside Palaver with a provider, model, and API key env var, using `pydantic-ai-slim`. It does not connect Claude Code, Codex, or either desktop app. — [User guide](https://github.com/CisterMoke/palaver/blob/HEAD/docs/user_guide.md); [pyproject](https://github.com/CisterMoke/palaver/blob/HEAD/pyproject.toml)
- **AgentPipe [Verified]**: spawns CLI tools as subprocesses. Codex uses `codex exec`. The only API-based agent is OpenRouter. — [README](https://github.com/kevinelliott/agentpipe)
- **Maestro [Verified]**: requires "at least one supported AI coding agent installed and authenticated". — [Installation docs](https://github.com/RunMaestro/Maestro/blob/HEAD/docs/installation.md). It drives Codex through `codex exec`, and Claude Code through `claude -p` or a TUI wrapper. — [Provider notes](https://github.com/RunMaestro/Maestro/blob/HEAD/docs/provider-notes.md)

### Inferences
- Because Codex desktop shares `~/.codex/config.toml`, a crewchat, walkie-talkie, or tyolab/parley MCP entry would probably appear as tools in Codex desktop. Whether crewchat's Codex hooks fire in the desktop app is unknown.
- Since `ChatGPT.app` bundles a `codex-cli` directory, "no CLI" is partly a matter of definition on this Mac: the binary exists either way. The user's preference may be better framed as "no separately managed CLI sessions".
- Crewchat's hooks may also work in the Claude desktop Code tab, since it reads CLI settings. This is plausible but unconfirmed, and it would not cover the chat tab.

### Gaps
- I found no project documentation of testing with the Codex desktop app and no user report of it working. Docs were searched selectively for the larger projects (Maestro especially), not read in full.
- Whether walkie-talkie's blocking `radio_standby` long poll (up to 1 hour) survives Codex or Claude Desktop MCP tool timeouts could not be determined from docs.

## Does it work with subscription login and no API keys?

### Takeaway
Every tool except Palaver avoids provider API keys, because they inherit whatever login the underlying agent uses. Palaver requires keys, and AgentPipe's OpenRouter mode does too.

### Cited Findings
- **[Verified]** Palaver providers are configured with an "API Key Env Var". — [User guide](https://github.com/CisterMoke/palaver/blob/HEAD/docs/user_guide.md)
- **[Verified]** AgentPipe authenticates Claude by running `claude` and following prompts, and `OPENROUTER_API_KEY` is needed only for OpenRouter. — [README](https://github.com/kevinelliott/agentpipe)
- **[Author claim]** Maestro says authentication works "exactly as" when running the provider directly. — [Installation docs](https://github.com/RunMaestro/Maestro/blob/HEAD/docs/installation.md)
- **[Author claim, cites Anthropic]** Maestro says a Claude plan login covers `claude -p` and TUI modes, drawing on plan limits, and warns that Anthropic plans to make `--bare` the default for `claude -p`, which would break plan login there, with TUI Wrapper as the fallback. — [Provider notes](https://github.com/RunMaestro/Maestro/blob/HEAD/docs/provider-notes.md). I did not check this against Anthropic's own article.
- **[Author claim]** The walkie-talkie blog post says it works within existing Pro or Max plans at no extra cost. — [dev.to post](https://dev.to/suruseas/i-made-claude-code-instances-talk-to-each-other-in-real-time-2kal)
- **[Verified]** Crewchat states "Waiting costs nothing; each message that wakes an agent costs it a turn", and it has no account of its own. — [Getting started](https://github.com/deepankar17/crewchat/blob/HEAD/docs/getting-started.md); [Privacy](https://github.com/deepankar17/crewchat/blob/HEAD/docs/privacy.md)
- **[Verified]** Tool-level tokens are unrelated to model billing. Walkie-talkie needs locally generated join and admin tokens, and tyolab/parley uses gateway tokens. — [walkie-talkie](https://github.com/suruseas/walkie-talkie); [parley](https://github.com/tyolab/parley)

### Inferences
- Subscription limits are the practical constraint: Agents talking to each other consume plan usage on every turn. Crewchat's turn limit and Maestro's limit handling suggest both authors have met this.

### Gaps
- No tool publishes measured usage for sustained multi-agent chat on a subscription.

## Does it support multiple rooms, topics, and human-controlled membership?

### Takeaway
Walkie-talkie, Palaver, and claude-slack have the closest room models, but Palaver is off-brief and claude-slack is Claude-only. No tool combines Slack-style channels, explicit topics, and strictly human-controlled membership for Claude and Codex together.

### Cited Findings
- **crewchat [Verified]**: "Each folder is its own project, with its own chat", with one tab per project. Agents "join by themselves" when a session opens in a connected folder. `crewchat hooks off` or `CREWCHAT_HOOKS=off` keeps sessions out. Channels within a project are not documented. — [README](https://github.com/deepankar17/crewchat); [Getting started](https://github.com/deepankar17/crewchat/blob/HEAD/docs/getting-started.md)
- **walkie-talkie [Verified]**: the dashboard can "Create and manage channels" and kick users. Agents also have tools to create, join, leave, and invite, so membership is not exclusively human-controlled. — [README](https://github.com/suruseas/walkie-talkie)
- **claude-slack [Verified]**: global and project-scoped channels with descriptions, access types, and agent frontmatter listing channels. Agents can join open channels through tools. — [README](https://github.com/theo-nash/claude-slack)
- **tyolab/parley [Verified]**: named rooms with a title. "A room is just a name", and agents create or join rooms themselves. — [README](https://github.com/tyolab/parley); [Onboarding doc](https://github.com/tyolab/parley/blob/HEAD/docs/onboard-your-agent.md)
- **parley-cli [Verified]**: channels with roles, and the first joiner is the owner, who can remove roles. The README calls membership "a cooperative protocol guard, not an access-control boundary". — [README](https://github.com/zerotomvp/parley-cli)
- **Palaver [Verified]**: chatrooms with a chosen list of participating agents and routing types (`round_robin`, `autonomous`, `single`, `incognito`). — [User guide](https://github.com/CisterMoke/palaver/blob/HEAD/docs/user_guide.md)
- **AgentPipe [Verified]**: one conversation per run, configured by flags or YAML. A topic panel shows the initial prompt. — [README](https://github.com/kevinelliott/agentpipe)
- **Maestro [Verified]**: a Group Chats sidebar section with "+ New Chat", each with its own queue and history. Participants are added automatically on @mention by the user or moderator. Removing a participant and topics are not described on the page I read. — [Group chat docs](https://docs.runmaestro.ai/group-chat.md)

### Inferences
- Maestro's auto-add on moderator @mention means a moderator can widen membership, which runs against human-controlled membership.

### Gaps
- I did not read Maestro's app source to confirm whether a participant can be removed through the UI.

## Can agents talk directly, debate, and review code, and do they keep local file access?

### Takeaway
Direct talk is available in everything except Maestro, which relays through a moderator. Tools that attach to real agents keep those agents' file access; Palaver's built-in agents have no documented file access.

### Cited Findings
- **crewchat [Verified]**: agents talk over MCP with no relay. Built-in roles include Reviewer and Advisor. The default limit is 10 consecutive agent-driven turns, after which only the human's messages wake an agent, configurable up to 50. — [Teams](https://github.com/deepankar17/crewchat/blob/HEAD/docs/teams.md); [Getting started](https://github.com/deepankar17/crewchat/blob/HEAD/docs/getting-started.md). Live cross-vendor use is reported for Claude Code and Cursor, dated 6 Nov 2026. **[Author claim]** — [Status](https://github.com/deepankar17/crewchat/blob/HEAD/docs/how-it-works.md#status)
- **crewchat [Verified]**: it warns that a chat message can ask agents to run commands and "a model can still be talked into things". — [README](https://github.com/deepankar17/crewchat)
- **walkie-talkie [Verified]**: the skill tells agents to run an autonomous loop, "NEVER" ask the user what to do, and execute operator instructions with Bash, Read, Write, and Edit. — [SKILL.md](https://github.com/suruseas/walkie-talkie/blob/HEAD/plugin/skills/walkie-talkie/SKILL.md). The README warns never to expose the Hub to the internet, because of arbitrary command execution. **[Author claim]** It also claims each agent's own security model stays intact. — [README](https://github.com/suruseas/walkie-talkie)
- **parley-cli [Verified]**: direct and broadcast sends, and the quick-start example is an author and reviewer exchange. — [README](https://github.com/zerotomvp/parley-cli)
- **AgentPipe [Verified]**: `round-robin`, `reactive`, and `free-form` modes, with a user input panel in the TUI. — [README](https://github.com/kevinelliott/agentpipe)
- **Maestro [Verified]**: agents do not talk directly and do not see each other's replies automatically. The moderator quotes earlier answers forward. A read-only toggle exists, and each agent runs in its own working directory. — [Group chat docs](https://docs.runmaestro.ai/group-chat.md)
- **Maestro [Verified]**: a macOS user reported that Group Chat ignored participant permission modes for Claude Code and Codex. — [Issue #1894](https://github.com/RunMaestro/Maestro/issues/1894), closed. A related fix PR was also closed; I did not confirm it merged. — [PR #1926](https://github.com/RunMaestro/Maestro/pull/1926)
- **Palaver [Verified]**: agents can message each other under `autonomous` routing. The part of the user guide I read covers no file or shell tools. — [User guide](https://github.com/CisterMoke/palaver/blob/HEAD/docs/user_guide.md)

### Inferences
- Maestro can run a debate only as a moderated one. For the user's "agents argue directly" goal, it is a structural mismatch rather than a missing feature.
- Agents with full file access and an always-on chat form a prompt-injection path, which crewchat and walkie-talkie both acknowledge.

### Gaps
- I found no independent test of debate or code-review quality for any tool.

## Does it run locally, and does any data go to a third party other than Anthropic or OpenAI?

### Takeaway
All can run locally. Third-party flows are mostly opt-in, apart from update checks to GitHub and Maestro's use of Sentry, whose defaults I could not confirm.

### Cited Findings
- **crewchat [Author claim]**: "collects nothing". The server listens on the local machine. It contacts GitHub about every 6 hours for an update check, which `CREWCHAT_NO_UPDATE_CHECK=1` disables. Optional links are Tailscale, the user's own Firebase (encrypted before sending), and an empty browser push. — [Privacy](https://github.com/deepankar17/crewchat/blob/HEAD/docs/privacy.md)
- **walkie-talkie [Verified]**: Hub on `localhost:9559`. The Slack bridge is optional and would send messages to Slack. — [README](https://github.com/suruseas/walkie-talkie)
- **claude-slack [Verified]**: SQLite plus Qdrant vectors, with embeddings from `all-MiniLM-L6-v2` via sentence-transformers. — [README](https://github.com/theo-nash/claude-slack); [Semantic search guide](https://github.com/theo-nash/claude-slack/blob/HEAD/docs/guides/semantic-search.md)
- **tyolab/parley [Verified]**: binds to `127.0.0.1` by default, using SQLite at `~/.parley/parley.db`. — [README](https://github.com/tyolab/parley)
- **parley-cli [Author claim]**: never sends conversations to a remote service. Its only default internet access is a cached GitHub release check. Files are plaintext with no built-in authentication or encryption. — [README](https://github.com/zerotomvp/parley-cli)
- **Palaver [Verified]**: local server at `localhost:8000`, but model traffic goes to whichever provider is configured. — [README](https://github.com/CisterMoke/palaver); [User guide](https://github.com/CisterMoke/palaver/blob/HEAD/docs/user_guide.md)
- **AgentPipe [Author claim]**: streaming to AgentPipe Web (`agentpipe.ai`) is "Disabled by default", "opt-in only". OpenRouter is an extra third party if used. — [README](https://github.com/kevinelliott/agentpipe)
- **Maestro [Verified]**: repo activity shows Sentry crash triage, for example PR titles like "fix(sentry): stop reporting three user-driven failures on main". — [PR #1970](https://github.com/RunMaestro/Maestro/pull/1970). It checks for updates on startup, which is configurable. — [Configuration docs](https://github.com/RunMaestro/Maestro/blob/HEAD/docs/configuration.md). Remote tunnelling via Cloudflare is optional. — [README](https://github.com/RunMaestro/Maestro)

### Inferences
- For a strict "Anthropic and OpenAI only" policy, Maestro needs its Sentry setting checked before use, and the others need only their optional integrations left off.

### Gaps
- I could not confirm Maestro's Sentry default, what it collects, or how to opt out. A targeted read of its settings code is needed.

## Does it wake agents automatically, or require polling or manual prompts?

### Takeaway
Tools that spawn agents wake them reliably (Maestro, AgentPipe). Tools attaching to open sessions rely on hooks or a blocking wait that eventually lapses (crewchat, walkie-talkie, parley). Desktop-app connections are poll-only where documented.

### Cited Findings
- **crewchat [Verified]**: delivery happens at the end of each turn through hooks. Claude Code waits 30 minutes by default (settable from 1 to 55) and then goes idle, seeing messages only when its user next types. Cursor checks once by default. Claude Desktop has no hooks. — [Getting started](https://github.com/deepankar17/crewchat/blob/HEAD/docs/getting-started.md); [README](https://github.com/deepankar17/crewchat)
- **walkie-talkie [Verified]**: `radio_standby` long-polls up to 1 hour, and the agent must loop back to it. — [README](https://github.com/suruseas/walkie-talkie); [SKILL.md](https://github.com/suruseas/walkie-talkie/blob/HEAD/plugin/skills/walkie-talkie/SKILL.md)
- **claude-slack [Verified]**: messages are read through tools such as `get_messages`. SSE exists for web clients. I found no documented agent wake. — [README](https://github.com/theo-nash/claude-slack)
- **tyolab/parley [Verified]**: a Claude Code Stop hook surfaces messages at turn boundaries. Idle wake uses `parley notify --wake-cmd`, for example with tmux, and needs a broker (tyo-mq, Redis, or NATS). It does nothing under default polling. — [README](https://github.com/tyolab/parley)
- **parley-cli [Verified]**: optional best-effort wake. Claude Code needs `claude --dangerously-load-development-channels server:parley` (Channels are a research-preview feature). Codex uses a persistent app-server. Others use a foreground `recv --wait`. — [README](https://github.com/zerotomvp/parley-cli)
- **AgentPipe [Verified]**: the orchestrator runs the CLIs itself in its conversation modes. — [README](https://github.com/kevinelliott/agentpipe)
- **Maestro [Verified]**: the moderator dispatches to agents, holds requests for busy agents, and moves on after 15 minutes. — [Group chat docs](https://docs.runmaestro.ai/group-chat.md)

### Inferences
- A Slack-like always-available agent is not what any session-attached tool provides. An agent idle past its wait window goes quiet until a person prompts it.

### Gaps
- I found no documented behaviour for crewchat's Codex hooks in practice. Its own status page lists them as covered by tests only.

## What are the license, stars, contributors, latest release or commit, and maintenance status?

### Takeaway
Only Maestro is a substantial, actively maintained project. Crewchat is very active but about five weeks old with one human author. Walkie-talkie and AgentPipe have gone quiet, and claude-slack appears abandoned.

### Cited Findings
All from the GitHub API on 2026-11-06. Contributor counts come from the contributors endpoint, including anonymous ones.

| Tool | License | Stars | Forks | Contributors | Latest release | Latest commit (default branch) | Created | Status |
|---|---|---|---|---|---|---|---|---|
| [crewchat](https://github.com/deepankar17/crewchat) | AGPL-3.0 (MIT through 1.1.0) | 1 | 0 | 2 (deepankar17, and "claude" with 3 commits) | v1.3.0, 2026-11-06 | 2026-11-06 | 2026-10-01 | Very active, single author, very new |
| [walkie-talkie](https://github.com/suruseas/walkie-talkie) | MIT | 13 | 7 | 1 | v1.7.0, 2026-03-08 | 2026-03-08 | 2026-02-27 | Dormant 8 months; [PR #121](https://github.com/suruseas/walkie-talkie/pull/121) open since 2026-06-01 |
| [claude-slack](https://github.com/theo-nash/claude-slack) | MIT | 8 | 3 | 1 | None on GitHub; [npm 4.1.4](https://www.npmjs.com/package/claude-slack), 2025-09-16 | 2025-09-16 | 2025-08-19 | Appears abandoned, about 14 months idle |
| [tyolab/parley](https://github.com/tyolab/parley) | MIT | 0 | 0 | 1 | None on GitHub; [PyPI 0.2.3](https://pypi.org/project/parley-agents/), 2026-09-11 | 2026-09-11; a feature branch was pushed 2026-11-03 | 2026-09-03 | Early, low adoption, some recent work |
| [parley-cli](https://github.com/zerotomvp/parley-cli) | GPL-3.0 | 14 | 1 | 1 | v2.2.0, 2026-08-25 | 2026-08-25 | 2026-07-31 | Quiet about 10 weeks after a fast start |
| [Palaver](https://github.com/CisterMoke/palaver) | AGPL-3.0 | 0 | 0 | 1 | v0.0.3, 2026-05-20 | 2026-05-20 | 2026-03-19 | Dormant about 5.5 months, very early |
| [AgentPipe](https://github.com/kevinelliott/agentpipe) | MIT | 154 | 25 | 4 | v0.7.0, 2025-11-18 | 2026-06-27 ("misc"; previous 2026-01-09) | 2025-09-12 | Slowing; no release in about a year; dependency PRs left open |
| [Maestro](https://github.com/RunMaestro/Maestro) | AGPL-3.0 | 3,549 | 380 | 69 | v1.0.2, 2026-10-21 | 2026-11-06 | 2025-11-23 | Very active; 129 open issues and PRs; lead author dominates commits (6,025 against 574 for the next) |

Registry data:
- parley-cli on NuGet: 1.6K total downloads, about 16 per day, updated 2026-08-25. — [NuGet](https://www.nuget.org/packages/parley-cli)
- Palaver on PyPI: 14 downloads in the last month. — [pypistats](https://pypistats.org/api/packages/palaver/recent)
- claude-slack on npm: 82 downloads, 2026-10-07 to 2026-11-05. — [npm API](https://api.npmjs.org/downloads/point/last-month/claude-slack)
- crewchat on PyPI: at least six releases between 2026-10-20 and 1.3.0 on 2026-11-06. — [PyPI](https://pypi.org/project/crewchat/)

### Inferences
- AGPL matters only if the user redistributes or builds on the tool. Crewchat also adds a credit requirement under its section 7(b) terms, per [its README](https://github.com/deepankar17/crewchat). Personal local use is unaffected.
- Crewchat's speed comes with churn risk: it changed license within weeks, and its release cadence means behaviour may shift quickly.

### Gaps
- PyPI download counts for crewchat and parley-agents were rate-limited (HTTP 429) and are not reported.

## How good are the docs, and are there independent reviews or real user reports?

### Takeaway
Independent evidence is close to nonexistent. Only Maestro has a third-party write-up, and even that relies on the creator's claims. Docs are strong for crewchat, Maestro, parley-cli, and AgentPipe.

### Cited Findings
Docs quality:
- **crewchat**: a full guide set, including a candid status page separating tested from untried features: "Not tried by hand yet ... Codex CLI, Gemini CLI, Qwen Code and OpenCode in a chat". — [Status](https://github.com/deepankar17/crewchat/blob/HEAD/docs/how-it-works.md#status)
- **Maestro**: a dedicated docs site, which labels Group Chat as beta per search results of its docs. — [Docs](https://docs.runmaestro.ai/group-chat.md)
- **parley-cli**: detailed README, spec, and tested versions per agent. — [README](https://github.com/zerotomvp/parley-cli)
- **AgentPipe**: long README (about 65 KB), though it still calls v0.6.0 the latest release while v0.7.0 exists, and it includes referral links. — [README](https://github.com/kevinelliott/agentpipe)
- **tyolab/parley**: the README contradicts itself, saying the MVP ships only SQLite and polling and later that Postgres and push transports are available. — [README](https://github.com/tyolab/parley)
- **Palaver**: short README and a basic user guide. — [README](https://github.com/CisterMoke/palaver)

Independent reviews and user reports:
- **Maestro**: Ry Walker's undated profile (latest data about June 2026) lists single-developer dependence, Windows stability problems, and the need for separate CLI installs. It treats group chat as a one-line capability. — [rywalker.com](https://rywalker.com/research/maestro-runmaestro)
- **Maestro**: the Hacker News launch got 7 points and 2 comments, both by the poster. — [HN](https://news.ycombinator.com/item?id=46307563)
- **Maestro complaints [Verified]**: a report of completed replies never reaching the group log: in one OpenCode run on Linux, 38 requests reached the provider and 37 answers were stored, but none reached the log. — [PR #1919](https://github.com/RunMaestro/Maestro/pull/1919), open. Group Chat SSH agents being blocked. — [Issue #1895](https://github.com/RunMaestro/Maestro/issues/1895), open. An earlier fix for a moderator claiming hand-offs it had not made. — [v0.18.5-RC notes](https://newreleases.io/project/github/RunMaestro/Maestro/release/v0.18.5-RC). 53 issues mention "group chat" (search on 2026-11-06). — [GitHub search](https://github.com/RunMaestro/Maestro/issues?q=is%3Aissue+%22group+chat%22)
- **walkie-talkie**: the only outside report found is a third-party PR describing two bugs, a wrong script path on manual install and `radio_channels` printing `[object Object]`. — [PR #121](https://github.com/suruseas/walkie-talkie/pull/121). The author's blog post has 0 comments. — [dev.to](https://dev.to/suruseas/i-made-claude-code-instances-talk-to-each-other-in-real-time-2kal)
- **AgentPipe**: real issues include misleading Codex error categorisation, where a timeout can surface as "authentication failed" — [Issue #49](https://github.com/kevinelliott/agentpipe/issues/49), inconsistent YAML durations — [Issue #50](https://github.com/kevinelliott/agentpipe/issues/50), and a WSL install failure — [Issue #47](https://github.com/kevinelliott/agentpipe/issues/47). All open. A web search found no HN or Reddit discussion.
- **tyolab/parley**: its one open PR reports reliability fixes "surfaced by agents dogfooding" the tool, so it is first-party. — [PR #2](https://github.com/tyolab/parley/issues/2)
- **crewchat**: no independent review found. Its Glama and mcprush badges are catalogue ratings, not user reviews. — [README](https://github.com/deepankar17/crewchat)
- **Adjacent tools surfaced by search, not evaluated**: agentchattr (multi-channel local chat with Claude and Codex launchers), nexor-agora, CTP Room, and Agent Room. These descriptions come from a search summary and a [mirror page](https://gh.r-mj.com/bcurts/agentchattr), so verify them directly. agentchattr looks most relevant to the multi-room brief.

### Inferences
- With no independent use reports for these tools in a Claude-plus-Codex setup, the user should treat any of them as an experiment and run a short hands-on trial before ruling out building.
- Low star counts mean bugs like walkie-talkie's `[object Object]` can go unnoticed for months.

### Gaps
- Reddit and Discord could not be searched thoroughly. Search returned no relevant threads, but absence there is weak evidence. Maestro's Discord is a likely source of complaints I could not reach.
- claude-slack, parley-cli, and Palaver: no independent reviews or user reports found. parley-cli has no filed issues at all.
