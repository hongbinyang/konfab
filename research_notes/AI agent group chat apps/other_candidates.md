# Other candidates for shared multi-room user + multi-agent chat on a Mac (beyond the known list)

Status as of 2026-11-06. All GitHub stars, licenses, push dates, and release dates were read from the GitHub API on 2026-11-06 through `gh api` unless stated otherwise. Links point to the repo page. Feature descriptions marked "README" or "vendor page" are vendor claims. I did not install or run any tool, so nothing here is hands-on tested.

Evidence labels used below:
- **Verified**: read directly from GitHub API data or first-party vendor documentation about its own product's mechanics.
- **Vendor claim**: a project's own README or site describes a feature, not independently confirmed.
- **Inference**: my reasoning, listed under Inferences.

## Which agent-orchestration desktop apps, multi-agent workspaces, agent message buses, and MCP-based agent chat servers are most used in 2026?

### Takeaway
Nobody publishes usage data, so GitHub stars are the only comparable proxy, and they are a weak one. The most starred tools in this space (Orca, Paperclip, Multica, Vibe Kanban) are mostly orchestrators or boards, not chat apps. The most starred tools that are really a shared chat are agentchattr (1,583), Reason Network (1,628, direct messages rather than rooms), Agent Relay (1,094), and MCP Agent Mail (2,232, mail threads rather than chat).

### Cited Findings

**Ranking A: real shared chat or messaging between agents (best fit to the objective, ordered by fit and evidence, not stars alone)**

| Rank | Tool | Stars | License | Last push | Latest release | Fit |
|---|---|---|---|---|---|---|
| 1 | [agentchattr](https://github.com/bcurts/agentchattr) | 1,583 | MIT | 2026-10-24 | v0.5.0, 2026-07-26 | Local channels, @mentions, agent-to-agent. Wake needs a CLI in tmux |
| 2 | [Agent Room](https://github.com/agent-room-alkl/agent-room) | 105 | MIT | 2026-10-12 | No GitHub release found | Only candidate found that lists Claude Desktop and the Codex desktop app as clients. Hosted by default |
| 3 | [Agent Relay](https://github.com/AgentWorkforce/relay) | 1,094 | Apache-2.0 | 2026-11-06 | v17.2.0, 2026-11-06 | Channels, threads, DMs. Very active |
| 4 | [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) and its [Rust successor](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) | 2,232 and 234 | MIT with rider (see below) | 2026-11-05 and 2026-11-06 | v0.3.2, 2026-04-16; Rust v0.3.40, 2026-11-01 | Threads, not rooms. Agents poll |
| 5 | [buddylist](https://buddylist.dev/) | Repo not found | Not stated | n/a | v0.7.0 mentioned, undated | Desktop group chat GUI. Runs agent CLIs |
| 6 | [Reason Network](https://github.com/reason-machines/reason-network) | 1,628 | Apache-2.0 | 2026-11-06 | v0.12.17, 2026-10-30 | Agent DMs across machines. No rooms described |
| 7 | [hcom](https://github.com/aannoo/hcom) | 640 | MIT | 2026-10-21 | v0.7.31, 2026-10-21 | Strong agent-to-agent. Tags, not rooms. Terminal only |
| 8 | [AgentBridge](https://github.com/raysonmeng/agent-bridge) | 422 | MIT | 2026-11-05 | Not checked | Claude Code and Codex live pair. Two agents, no rooms |
| 9 | Slock (closed, no public repo found) | n/a | Listed as closed source | n/a | n/a | Channels with task claiming. Weak evidence |
| 10 | [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) | 2,208 | MIT | 2026-04-26 | Not checked | Claude Code only, and stale |

**Ranking B: most popular adjacent tools (orchestrators, boards, assistants). Mostly not chat, included for popularity context**

| Tool | Stars | License | Last push | Latest release | What it is |
|---|---|---|---|---|---|
| [Orca](https://github.com/stablyai/orca) | 117,646 | MIT | 2026-11-06 | v1.4.251, 2026-11-06 | Fleet of coding agents "with your own subscription" (repo description). Repo created 2026-03-17 |
| [Paperclip](https://github.com/paperclipai/paperclip) | 111,699 | MIT | 2026-11-06 | Not checked | "Manage agents at work". Repo created 2026-03-02 |
| [LobeHub](https://github.com/lobehub/lobehub) | 84,229 | NOASSERTION | 2026-11-06 | Not checked | Super-agents in team chats |
| [ruflo](https://github.com/ruvnet/ruflo) (was claude-flow) | 81,071 | MIT | 2026-11-06 | Not checked | Swarm harness |
| [Multica](https://github.com/multica-ai/multica) | 55,152 | Custom, Apache 2.0 plus conditions | 2026-11-06 | v0.8.1, 2026-11-06 | Issue board plus chat, squads |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | 46,806 | MIT | 2026-11-06 | Not checked | Chat UI for model providers |
| [Open WebUI](https://github.com/open-webui/open-webui) | 157,935 | NOASSERTION | 2026-11-06 | Not checked | Chat UI for models |
| [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) | 34,072 | Apache-2.0 | 2026-11-05 | v2.2.2, 2026-09-09 | Cowork app across 20+ CLI agents |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 28,609 | Apache-2.0 | 2026-11-04 | v0.1.44, tagged 2026-04-24 | Kanban board per agent |
| [A2A protocol](https://github.com/a2aproject/A2A) | 26,436 | Apache-2.0 | 2026-11-05 | Not checked | Protocol, not an app |
| [happy](https://github.com/slopus/happy) | 24,522 | MIT | 2026-11-06 | cli-1.2.5, 2026-09-22 | Mobile and multi-agent client, "reuses the subscriptions you already" have (repo description) |
| [Gas Town](https://github.com/gastownhall/gastown) | 18,713 | MIT | 2026-10-28 | Not checked | Multi-agent workspace manager |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 16,262 | None detected | 2026-11-06 | Not checked | Bridges local agents to messaging platforms |
| [Paradev](https://github.com/ParadevAI/Paradev) | 16,022 | MIT | 2026-11-06 | desktop-v2.0.5, 2026-11-05 | Open-source Codex App and Conductor alternative |
| [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | 14,176 | Apache-2.0 | 2026-11-06 | Not checked | Fleet supervision, desktop |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | 8,740 | AGPL-3.0 | 2026-08-20 | v1.0.20, 2026-08-20 | tmux session manager |
| [Emdash](https://github.com/generalaction/emdash) | 6,207 | Apache-2.0 | 2026-11-06 | v1.2.11, 2026-11-06 | Parallel agent environment |
| [OpenAgents](https://github.com/openagents-org/openagents) | 4,345 | Apache-2.0 | 2026-11-06 | Not checked | "Collaboration OS for AI agents". Not inspected further |
| [Golutra](https://github.com/golutra/golutra) | 3,866 | NOASSERTION | 2026-09-28 | Not checked | Multi-agent orchestration. Not inspected further |
| [Crystal](https://github.com/stravu/crystal) | 3,127 | MIT | 2026-02-26 | v0.3.5, 2026-02-26 | Stale, no push since February |
| [Nimbalyst](https://github.com/nimbalyst/nimbalyst) | 2,030 | MIT | 2026-11-04 | Not checked | Visual workspace |
| [Agor](https://github.com/preset-io/agor) | 1,485 | NOASSERTION | 2026-11-06 | Not checked | "Multiplayer AI". Not inspected further |
| Conductor | No repo checked | Not stated; listed as "Free, BYOK" by [Nimbalyst](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/) | n/a | 0.93.0 per [vendor page](https://www.conductor.build/) | Mac app for parallel agents in isolated workspaces |

**Popularity comparison with the known list (GitHub, 2026-11-06)**
- [Mattermost](https://github.com/mattermost/mattermost) 39,549; [Maestro](https://github.com/RunMaestro/Maestro) 3,549; [AgentPipe](https://github.com/kevinelliott/agentpipe) 154; [theo-nash/claude-slack](https://github.com/theo-nash/claude-slack) 8.
- agentchattr, Reason Network, Agent Relay, and MCP Agent Mail all exceed AgentPipe and claude-slack on stars. None approaches Mattermost, which is general team chat rather than an agent tool.

**Maintenance signals**
- Vibe Kanban: one source says Bloop shut down in April 2026 and the project moved to community maintenance, per [Nimbalyst](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/) (a competitor). GitHub still shows a push on 2026-11-04 but the latest release tag is 2026-04-24, per [the repo](https://github.com/BloopAI/vibe-kanban).
- MCP Agent Mail's Python repo calls itself deprecated and recommends the Rust rewrite, per [its README](https://github.com/Dicklesworthstone/mcp_agent_mail). The rewrite has only 234 stars, so the 2,232 figure belongs to the deprecated repo.
- Long-tail chat projects exist in quantity but with almost no adoption: [TobiasCoding/agent-chat-mcp](https://github.com/TobiasCoding/agent-chat-mcp) 0 stars, [larryflorio/agent-chat](https://github.com/larryflorio/agent-chat) 7, [Islomov49/agents-secure-chat](https://github.com/Islomov49/agents-secure-chat) 1, [modula-relay](https://github.com/modulastack/modula-relay) 3, [ducduong/multi-agent-chat](https://github.com/ducduong/multi-agent-chat) 0, [AgentSlack](https://github.com/zezhuyu/AgentSlack) 1, [agentchatme/agentchat](https://github.com/agentchatme/agentchat) 18.

### Inferences
- Orca's and Paperclip's star counts look unusually high for repos under nine months old. Orca shows 117,646 stars but only 159 watchers. That ratio may point to inflated stars or viral promotion. I have no direct proof, so the star figures should not be read as usage.
- In this category, popularity runs inversely to fit. Orchestrators treat agents as isolated parallel workers, which is the opposite of a shared conversation.

### Gaps
- No download, active-user, or telemetry data was found for any tool. Rankings rest on stars and on recency.
- Slock's stars, license, and repo could not be verified. Its evidence is one non-commercial guide site.
- Conductor's usage is unknown. Its vendor page gives [no metrics or customer names](https://www.conductor.build/).
- Reddit and Hacker News sentiment was not captured in any useful depth. My searches did not return usable threads, so absence here does not mean no discussion exists.

## For each promising candidate, how do agents connect, does subscription login work, is there multi-room chat, does it run locally, and can agents talk to each other?

### Takeaway
Most candidates reuse subscription logins only indirectly, by driving an installed and signed-in agent CLI. Agent Room is the only one found that documents a route for the desktop apps, but it depends on a listen loop for presence and is hosted by default.

### Cited Findings

**agentchattr** ([README](https://github.com/bcurts/agentchattr), vendor claims)
- Connect: MCP over HTTP at `127.0.0.1:8200/mcp`, with a proxy per agent for identity. The README says any MCP-compatible agent can join.
- Wake: a CLI wrapper injects a prompt into the agent's terminal on @mention. On Mac it uses tmux and bracketed paste. Mac needs Python 3.11+ and tmux.
- Rooms: yes, channels that users can create, rename, and delete.
- Agent-to-agent: yes, with a per-channel loop guard (example `max_agent_hops = 4`) and `/continue`.
- Local: designed for localhost only.
- Login: no account of its own, and nothing that needs a model key for CLI agents. Agents use whatever login their CLI already has (inference from the wrapper design).
- Desktop apps: Claude Desktop and the Codex app are not mentioned.

**Agent Room** ([README](https://github.com/agent-room-alkl/agent-room), [site](https://www.agent-room.com/), vendor claims)
- Connect: hosted MCP endpoint at `https://www.agent-room.com/mcp`, or stdio for local installs, plus REST.
- Clients: Claude Code, Claude Desktop and claude.ai through a remote connector URL, Codex CLI, IDE, and desktop through stdio config, plus Cursor, Windsurf, Antigravity, OpenClaw, Hermes.
- Wake: listen loops using `room_listen`; hooks at turn boundaries on the local install for Claude Code; signed webhooks for resident assistants.
- Rooms: yes, 9-character codes, open, sequential, or moderator modes. Rooms expire after 24 hours on default Redis storage.
- Human UI: browser client where a human can watch or take part.
- Local: self-hostable on Vercel with Upstash Redis, optional Postgres, so "self-hosted" is not the same as fully on-Mac by default.
- Keys: the README does not mention API keys or describe auth, so room privacy needs checking.
- Task board: evidence-gated, a different agent has to verify a task.

**Agent Relay** ([README](https://github.com/AgentWorkforce/relay), vendor claims)
- Connect: `npx -y agent-relay@next init` in a project, then Claude Code or Codex sessions join by themselves.
- Rooms: channels, threads, DMs, files, search.
- Local: local by default, with `--hosted` for teams, and self-hosting guidance.
- Other: a paid desktop app exists. Subscription login and human UI are not described. Desktop apps are not mentioned.

**MCP Agent Mail** ([README](https://github.com/Dicklesworthstone/mcp_agent_mail), vendor claims)
- Connect: HTTP MCP on port 8765, with stdio also available. Names Claude Code, Codex, Gemini CLI, Factory Droid. Claude Desktop is not mentioned.
- Rooms: none. Projects and `thread_id` act as containers.
- Wake: none described, agents poll `fetch_inbox`.
- Human UI: web UI at `/mail` with a Human Overseer composer.
- Local: yes, git-backed archive and SQLite. No API key strictly needed locally, a bearer token is generated.

**buddylist** ([site](https://buddylist.dev/), vendor claims)
- Connect: Claude Code is built in, the others run through their own CLI. A group chat with @mentions and up to six agent turns per message by default.
- Login: "Each agent signs in the way it does in your terminal", with Claude Code using its login or an API key.
- Rooms: multiple conversations are implied but multi-room is not explicitly described.
- Local: yes, each agent in its own git worktree. Apple Silicon Mac only on macOS. Free.
- Note: a GitHub search for it only found an [unrelated 1-star project](https://github.com/Rishbah-76/buddylist), so its source and license are unconfirmed.

**Reason Network** ([README](https://github.com/reason-machines/reason-network), vendor claims)
- Connect: background daemon plus an MCP server, with tools such as `list_team`, `send_message`, `ask_user`. Hosted assistants add an MCP URL.
- Login: needs a free Reason account, not a model key.
- Rooms: none described. One-to-one addressing such as `alice/api-claude`, plus broadcasts from a human.
- Local: peer-to-peer through iroh, with a relay fallback that sees only encrypted bytes. Default relay is Reason's and can be self-run.
- UI: Mac menu bar icon and approval pop-ups. Claude Desktop not mentioned, and Codex desktop not clearly covered.

**hcom** ([README](https://github.com/aannoo/hcom), vendor claims)
- Connect: hooks and a local SQLite database. Agents launched through hcom, with CLI agents wrapped.
- Rooms: tags (`@tag`), not rooms. Human UI is a TUI.
- Agent-to-agent: yes, mid-turn delivery, waking idle agents, spawn and fork. Local by default.

**AgentBridge** ([Codex discussion](https://github.com/openai/codex/discussions/15374), posted 2026-03-20, author's claims)
- A local MCP server linking Claude Code Channels to Codex App Server over JSON-RPC, with mid-execution injection both ways and no cloud service. Two participants, no rooms. No visible Codex team reply.

**Multica** ([README](https://github.com/multica-ai/multica), vendor claims)
- A local daemon spawns agent CLIs that must be "installed and signed in". Main surface is the issue board, with a Chat feature and squads with a routing leader. Has an Electron desktop app for macOS. Self-hostable with Docker. Source-available license with added conditions, though the README also says open-source.

**Slock** (third-party only, low confidence)
- A [setup guide](https://codepick.dev/en/guides/slock-setup/) says it uses `npx @slock-ai/daemon`, which scans for claude, codex, gemini, and opencode CLIs. Agents run on your machine, with channels and task claim. A [comparison guide](https://codepick.dev/en/guides/agent-collaboration-platforms-2026/) lists it as cloud and closed source, and free.

**Conductor** ([vendor page](https://www.conductor.build/))
- Runs Claude Code, Codex, and Cursor agents in isolated workspaces on a Mac. The page does not mention subscription login, price, inter-agent messaging, or rooms.
- Third-party pricing conflicts: a search summary across comparison blogs (sources not individually attributed, see the list in the last section) gave both a free tier with Pro at $50 per month and "free for now". [Nimbalyst](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/) lists "Free, BYOK". I did not resolve this, so treat all of it as unverified.

**Named examples that do not fit**
- Claude Squad: [tmux wrapper](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/) with no inter-agent features stated.
- Vibe Kanban: [card equals worktree equals agent](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/), with no inter-agent features stated.
- A2A chat clients: GitHub search found only tiny ones, such as [NullClawUI](https://github.com/vernonstinebaker/NullClawUI) with 2 stars and [a2a-client-app](https://github.com/jms-dcksn/a2a-client-app) with 0.
- "Agent Teams" is ambiguous. It can mean Anthropic's feature, covered in the next section, or a separate desktop app in [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators), which I did not inspect.

### Inferences
- A standard MCP server cannot start an agent's turn. Anthropic's docs state that with a standard MCP server ["nothing is pushed to the session"](https://code.claude.com/docs/en/channels.md). That explains why these tools fall into two camps: terminal injection and hooks (agentchattr, hcom), or polling and listen loops (Agent Mail, Agent Room). A desktop app with no CLI cannot be terminal-injected, so a listen loop that burns turns, or a human nudge, is the likely fallback.
- agentchattr's HTTP MCP endpoint could probably be added to the Codex app, since the [Codex MCP docs](https://developers.openai.com/codex/mcp) list Streamable HTTP. Agents would be able to read and post, but auto-wake would not work. This is untested.
- Open WebUI and LibreChat are chat front ends for model providers, so they would normally need API keys or a local model endpoint and would not treat the Claude or Codex apps as participants. This rests on repo descriptions and background knowledge, not on a check of their docs today.

### Gaps
- Whether Agent Room's listen loop works reliably in Claude Desktop and in the Codex app, and whether stdio works in the Codex app as documented, was not tested.
- Subscription-login terms for third-party tools driving CLIs were not reviewed. Whether any provider's terms restrict this is out of what I checked.
- Paperclip, OpenAgents, Agor, Golutra, Clawith, AionUi, Paradev, and Orca's internal messaging were not inspected beyond repo metadata. One of them could have stronger chat features than its description suggests.

## What are the license, GitHub stars, latest release date, docs quality, and independent reviews?

### Takeaway
Stars, licenses, and dates are in the tables above. Independent review evidence is thin everywhere: nearly all comparison articles come from vendors of competing tools, and I found no independent review of any of the Ranking A tools.

### Cited Findings
- MCP Agent Mail's license is ["MIT License (with OpenAI/Anthropic Rider)"](https://github.com/Dicklesworthstone/mcp_agent_mail), which GitHub reports as NOASSERTION, so its terms should be read before adoption. I read only the header, not the rider text.
- Multica's license is [Apache 2.0 text with added conditions](https://github.com/multica-ai/multica) on hosted services, commercial embedding, and branding.
- [cc-connect](https://github.com/chenhg5/cc-connect) has no license detected by GitHub (API returned null), and neither do [AgentSlack](https://github.com/zezhuyu/AgentSlack) or [ducduong/multi-agent-chat](https://github.com/ducduong/multi-agent-chat).
- Docs quality, first-hand from reading READMEs: Agent Mail's README is very long (about 147k characters on fetch). agentchattr and Agent Room have clear READMEs covering connection, wake, and security limits. Agent Room does not explain auth. This is my judgment, not an external rating.
- agentchattr was not among the chat-related entries returned from a filtered summary of [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators), while hcom, buzz, and ruflo were. Because the summary was filtered, this does not prove agentchattr is absent from the list.

### Inferences
- Agent Room's low star count (105) against its unique desktop-app coverage suggests that the desktop-app route is a niche few people are using, so reliability evidence should be expected to be poor.

### Gaps
- No independent reviews, benchmarks, or security audits were found for agentchattr, Agent Room, Agent Relay, buddylist, or Reason Network.
- Release dates marked "Not checked" were not retrieved. Agent Room has no GitHub release entry returned by my check, and its npm history was not reviewed.

## Does any tool fully satisfy all of these: Claude and Codex desktop apps as participants, no API keys, no model CLIs, multi-room chat, agent-to-agent conversation, and local operation? If not, which come closest, and which requirement do they miss?

### Takeaway
No tool I found fully meets all six as documented. Agent Room comes closest on the desktop-app and no-CLI requirements but misses fully local by default and has unverified always-on behavior. agentchattr comes closest on local multi-room agent-to-agent chat but needs CLIs in tmux for wake.

### Cited Findings

| Tool | Both desktop apps | No API keys | No model CLI | Multi-room | Agent-to-agent | Local |
|---|---|---|---|---|---|---|
| [Agent Room](https://github.com/agent-room-alkl/agent-room) | Claimed by README | Not stated | Likely for desktop clients (inference from connector and stdio config; stdio install may need Node) | Yes, 24h expiry on default storage | Yes | Partly: hosted default; self-host uses Vercel and Upstash |
| [agentchattr](https://github.com/bcurts/agentchattr) | Not mentioned | Yes for CLI agents (inference) | Fails: wake needs a CLI | Yes | Yes | Yes |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Not mentioned | Yes locally | Not required by MCP itself, but installer targets CLIs | Threads only | Yes, polled | Yes |
| [Reason Network](https://github.com/reason-machines/reason-network) | Not clear | Needs Reason account, no model key stated | Not clear: needs its daemon, and its listed agents are mostly CLIs | No rooms described | Yes | Partly: P2P with relay fallback |
| [buddylist](https://buddylist.dev/) | No, uses CLIs | Subscription works through CLI login (vendor claim) | Fails: Claude Code built in, others need their CLI | Unclear | Yes, up to 6 turns | Yes |
| [Agent Relay](https://github.com/AgentWorkforce/relay) | Not mentioned | Not stated | Not clear | Yes | Yes | Yes by default |

**First-party routes, which stay within one vendor**
- Claude Code [agent teams](https://code.claude.com/docs/en/agent-teams): experimental and off by default. Teammates message each other directly and use mailbox files under `~/.claude/teams`. One team per session and no nesting. Spawning requires an interactive session. Teammates are Claude Code instances, and the docs describe no way for Codex to join.
- Claude Code [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md): on by default from v2.1.224 on macOS. The docs say a session in "the VS Code extension or the Desktop app" keeps held messages until a deadline, which indicates Desktop sessions take part. Idle sessions start a new turn when a message arrives. Local delivery uses a per-session socket and never passes through Anthropic servers. A hook or Bash command can post into a session's own socket.
- Claude Code [channels](https://code.claude.com/docs/en/channels.md): research preview. An MCP server pushes events into a running session and can be two-way. Works with claude.ai login. Started with a `--channels` CLI flag, and custom channels need `--dangerously-load-development-channels` during preview. Pro, Max, and Ultra users without an organization skip the admin checks.
- Codex [subagents](https://developers.openai.com/codex/concepts/subagents): per search summary of OpenAI docs, enabled by default in current releases, with the app showing each subagent thread. Custom agents inherit the parent's MCP servers. Not fetched directly.
- Codex [MCP](https://developers.openai.com/codex/mcp): per search summary, the ChatGPT desktop app, CLI, and IDE extension share MCP config, with STDIO and Streamable HTTP transports. The search summary also describes [sign-in](https://developers.openai.com/codex/auth) by ChatGPT subscription or API key.
- Codex [app-server](https://learn.chatgpt.com/docs/app-server): JSON-RPC with `turn/start`, `turn/steer` ("append user input to the currently in-flight turn without creating a new turn"), and `thread/inject_items`. It is started with `codex app-server`, so it uses the Codex binary. The docs do not say if the desktop app shares this server.
- Per search summaries of the [changelog](https://developers.openai.com/codex/changelog/), the old `codex mcp-server` command was removed in September 2026, with app server as the replacement. Older Claude Desktop guides that launch Codex as an MCP server, such as [this one](https://cor-jp.com/en/blog/codex-mcp-troubleshooting/), may therefore be out of date. I did not open the changelog entry.

**Other findings**
- One targeted search for a desktop-only, no-CLI setup found no matching Show HN post. The closest result was [AgentBridge](https://github.com/openai/codex/discussions/15374), which targets Claude Code Channels rather than the Claude desktop app. One search does not establish absence.

### Inferences
- The missing piece is a wake path into the two desktop apps. On the Claude side, cross-session sockets and channels are real push paths, but both are Claude Code features, and channels need a CLI flag. On the Codex side, `turn/steer` is the push path but goes through the Codex binary, though the binary may ship inside the desktop app (not confirmed).
- A build for this requirement would likely use one local MCP server for rooms, used by both apps through their MCP settings, with desktop agents in a blocking listen call. That matches Agent Room's pattern. It costs subscription usage while looping, and may stop when a turn ends.
- "No model CLI" is the hardest requirement to meet. Nearly every popular tool treats an installed CLI as the participant. Dropping it would widen options to agentchattr, buddylist, and hcom.

### Gaps
- Whether a third party can start a turn in the Claude desktop app or the Codex desktop app without any CLI could not be confirmed either way.
- Whether Claude Desktop's chat tab, as opposed to its Code tab, can take part in cross-session messaging was not established. The docs refer to "the Desktop app" without separating them.
- Long-running listen loops in either desktop app were not tested, including any timeout on MCP tool calls.

## Are there curated lists or comparison articles for this category that give independent evidence?

### Takeaway
Yes, but independence is limited. The most useful curated source is awesome-agent-orchestrators. Most comparison articles are from vendors of competing tools, so their placements should be discounted.

### Cited Findings

**Curated lists**
- [andyrewlee/awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators): 2,359 stars, CC0, pushed 2026-11-05. Sections include Multi-Agent Swarms and Agent Infrastructure & Primitives. A [ranked derivative](https://github.com/jdoepfert/awesome-ranked-ai-orchestrators) also exists, with 0 stars.
- Chat-style entries in that list worth a follow-up, unverified beyond its one-liners: Agora, Alook, Cotal, Hotline, Clideck, lorca, shire, Sno Station, Friday, Traycer, Threadlines, Concord MCP, Cyclops, takopi. It also lists Buzz from the known list. [ai-maestro](https://github.com/23blocks-OS/ai-maestro) (844 stars) and [Traycer](https://github.com/traycerai/traycer) (1,657 stars) are in the list and are active. GitHub keyword searches did not locate repos for Clideck, Alook, Cotal, Agora, or Hotline, so their stars are unknown.
- [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) (57,396 stars) and [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) (97,381 stars) exist but were not searched for this topic.
- [awesome-agent-boards](https://github.com/Hugo0/awesome-agent-boards) (5 stars) covers public places where agents talk, which is a different use case.

**MCP directories**
- [Glama's agent-chat listing](https://glama.ai/mcp/servers/TobiasCoding/agent-chat-mcp) and [mcp.pub's Agent Room listing](https://mcp.pub/servers/agent-room/) exist. They are listings rather than reviews.

**Comparison articles (author interest noted)**
- [Nimbalyst, "Best Multi-Agent Coding Tools"](https://nimbalyst.com/blog/best-multi-agent-coding-tools-2026/), published 2026-04-24, updated 2026-05-11. Written by Nimbalyst's CEO. It calls Claude Code Agent Teams the only tool in its list with explicit peer messaging, and it also describes structured inter-agent messaging in Codex multi-agent v2. It does not cover chat-first tools.
- [CodePick, Agent Collaboration Platform Guide](https://codepick.dev/en/guides/agent-collaboration-platforms-2026/), published 2026-05-09, non-commercial personal project with no named author, and it warns content may be outdated. It compares Slock, Multica, LobeHub, Orkas. It has internal inconsistencies, such as Slock listed as cloud while agents run locally.
- Vendor-written lists, not opened in full: [GitKraken](https://www.gitkraken.com/blog/7-best-multi-repo-ai-agent-orchestration-tools-2026), [Tembo](https://www.tembo.io/blog/ai-agent-orchestration-tools), [crystl](https://crystl.dev/blog/best-ai-agent-orchestration-tools/), [agentsroom](https://agentsroom.dev/blog/best-multi-agent-coding-tools), [Agentastic](https://www.agentastic.dev/compare/ai-coding-agent-orchestration-tools), [Parallel Code](https://parallelcode.app/blog/multi-agent-coding-tools-2026/).
- Practitioner essay: [Addy Osmani, "The Code Agent Orchestra"](https://addyosmani.com/blog/code-agent-orchestra/), appeared in search and was not opened.

### Inferences
- Comparison articles rank orchestrators well above chat tools, likely because their authors sell orchestrators. No comparison specific to chat-first agent tools was found, so this category has little independent evaluation.
- The awesome-agent-orchestrators list is likely the best lead for the next round of checks because it has a dedicated swarm section and is maintained.

### Gaps
- No independent article comparing chat-first tools such as agentchattr, Agent Room, and hcom was found.
- Reddit threads from r/ClaudeAI, r/codex, and r/LocalLLaMA were not surfaced by my searches, and Hacker News discussion could not be confirmed.
