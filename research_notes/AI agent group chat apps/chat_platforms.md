# Established chat platforms as hosts for AI agents (as of 2026-11-06)

Evidence labels used below:
- **[Verified]**: read directly in official docs or in source code.
- **[Vendor claim]**: stated by a vendor about its own product, in marketing or a README. Not independently tested.
- **[Community]**: a third-party repo, blog or forum post.
- Inferences are listed separately under "Inferences".

No setup was run for these notes. Everything is from reading documents, so nothing here has been tested on a Mac. Pages were read through a fetch tool that summarizes long pages. Details not quoted from a full page should be rechecked before a final decision. All GitHub star counts were read on 2026-11-06.

## Can the Claude and Codex desktop apps connect to the platform through an existing MCP server, and read and post messages?

### Takeaway
Yes for on-demand reading and posting, and Mattermost is the strongest candidate: it has a first-party MCP server, and its README names Claude Desktop and Claude Code as clients. Codex's HTTP transport should fit, but no source confirms that pairing. A self-hosted server on localhost cannot be added through Claude's normal connector UI, because those connections come from Anthropic's cloud.

### Cited Findings

**Client side**
- **[Verified]** Claude remote custom connectors connect from Anthropic's servers, not from the user's machine. The server must be publicly reachable, so private or firewalled servers fail — [Anthropic help](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).
- **[Verified]** Local servers in `claude_desktop_config.json` are a separate mechanism that uses the local network. They are not available in Cowork or claude.ai. Claude Desktop will not connect to remote servers configured directly in that file; those must go through Settings > Connectors — [Anthropic help](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).
- **[Verified]** Codex supports STDIO and streamable HTTP MCP servers. "The ChatGPT desktop app, Codex CLI, and IDE extension share this configuration" — [OpenAI MCP docs](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli). OpenAI's docs now describe the desktop surface as the ChatGPT desktop app.
- **[Verified]** OAuth sign-in for Codex MCP servers is available through `codex mcp login` or an Authenticate button in the desktop app, per a search summary of [OpenAI's docs](https://developers.openai.com/codex/mcp.md). The summary was not checked against the full page.

**Mattermost**
- **[Vendor claim]** The MCP server is built into `mattermost-plugin-agents`, at `/plugins/mattermost-ai/mcp-server/mcp`. It uses streamable HTTP, supports OAuth with dynamic client registration or a personal access token, claims 100+ tools, and names Claude Code, Claude Desktop, Cursor and VS Code as clients. Codex is not named. It needs no separate install. It requires Mattermost Server v12.0.0+ — [repo README](https://github.com/mattermost/mattermost-plugin-agents).
- **[Vendor claim]** Announced 2026-01-16 as available "for all Mattermost plans", through Agents v1.7.2+. External clients use an `/mcp` endpoint that must be enabled, and agents inherit the user's permissions. The post names Claude and ChatGPT, not Codex. It also says every action a Mattermost Agent takes requires explicit approval — [Mattermost blog](https://mattermost.com/blog/mattermost-mcp-server/).
- **Conflict:** the blog (January 2026) cites Agents v1.7.2+ while the current README requires Server v12.0.0+. These may both be true, since one is a plugin version and the other a server version. Use the current README.
- **Maturity signal:** 257 stars, 113 forks, 733 commits. The fetched page showed an empty Releases section and an experimental `latest-master` build — [repo](https://github.com/mattermost/mattermost-plugin-agents).
- **[Community]** Third-party Mattermost MCP servers also exist, for example one on Cloudflare without OAuth, intended for trusted environments — [listing](https://mcpmarket.com/server/mattermost-5). Not evaluated further.

**Rocket.Chat**
- **[Verified]** A first-party MCP server exists but is **Alpha** and off by default (8.8.0+; OAuth from 9.0.0). "The workspace license must include the Rocket.Chat AI add-on", and the license is obtained through Sales. The default set is 11 tools; the extended set is 131. OAuth tokens carry no scopes, so they cannot restrict a client to read-only — [Rocket.Chat docs](https://docs.rocket.chat/docs/mcp-server).

**Zulip**
- I found no official Zulip MCP server in search. This is an absence of results, not proof that none exists.
- **[Community]** `monadical-sas/zulip-mcp`: 8 tools (list channels, post, DM, react, channel history, topics, subscribe, users), 12 stars, 9 commits, Apache-2.0 — [repo](https://github.com/monadical-sas/zulip-mcp). A [listing](https://lobehub.com/ko/mcp/monadical-sas-zulip-mcp) says MIT, which conflicts; treat the repo as authoritative.
- **[Community]** `zulipchat-mcp` on PyPI advertises Claude Code, Codex and Gemini CLI as clients and offers dual bot identity — [PyPI](https://pypi.org/project/zulipchat-mcp/0.7.4/).

**Matrix/Element**
- **[Community]** No first-party Matrix MCP server turned up. Options found:
  - `matrix-mcp` (MindRoom): stdio, reads and writes rooms — [PyPI](https://pypi.org/project/matrix-mcp/).
  - `matrix-channel-mcp` (jouve): bridges **one room** per server instance to Claude Code's channel feature, and can run against a bundled Docker homeserver — [Glama](https://glama.ai/mcp/servers/dlvd13ijr8).
  - `@northbound-run/matrix-agent-claude-code-channel`: an npm channel package — [pkgstats](https://www.pkgstats.com/pkg:@northbound-run/matrix-agent-claude-code-channel).
  - Vinkius: a hosted service, so it adds a third party — [Vinkius](https://vinkius.com/client/claude-code/connect/matrixelement-mcp).

**Slack and Discord**
- **[Community, conflicting]** Slack reportedly has an official remote MCP server. One guide says Claude's Slack connector is limited to Team and Enterprise plans and cannot post — [eSEOspace](https://eseospace.com/blog/connect-claude-to-slack-mcp/). Another lists sending messages among the server's capabilities — [Composio](https://composio.dev/content/slack-mcp-setup). I did not verify either against Slack's or Anthropic's own pages.

### Inferences
- A localhost Mattermost server cannot use Claude's Settings > Connectors route. The likely working route for the Claude desktop app is a local stdio entry in `claude_desktop_config.json`, wrapping the HTTP endpoint. Opening a public tunnel would add a third party.
- Codex's direct streamable HTTP support suggests it can connect to `http://localhost:8065/...` with a token. This is untested, and the port is Mattermost's usual default rather than something I confirmed in these sources.
- Mattermost's first-party server is much more mature than the single-maintainer servers for Zulip and Matrix, but the star counts are modest for all of them.

### Gaps
- No source shows Codex connected to the Mattermost MCP server.
- I did not confirm whether the MCP endpoint works when the Agents plugin has no LLM provider configured.
- I did not confirm which MCP config the Claude desktop app's Code tab reads.
- Last-commit dates were not visible for `mattermost-plugin-agents` or `zulip-mcp`, so recent activity is unconfirmed.

## Does this let agents respond when mentioned, or does a person have to prompt the agent? Do official integrations wake agents, where do they run, and can they reach local files?

### Takeaway
A plain MCP connection does not wake anyone: a person or a scheduled job has to start the turn. The official Slack integrations do wake on mention, but they run in provider clouds with GitHub repositories, not on local files. The only documented local wake is Claude Code channels, which needs the `claude` CLI, and no equivalent official mechanism was found for Codex.

### Cited Findings

**Plain MCP**
- **[Verified]** Anthropic's comparison of standard MCP servers: "Claude queries it during a task; nothing is pushed to the session" — [channels docs](https://code.claude.com/docs/en/channels).

**Claude in Slack, individual plans (earlier version)**
- **[Verified]** It answers channel @mentions only from Pro, Max and Ultra accounts, and only in a workspace not connected to Claude Tag. It creates a **cloud session** and requires a GitHub-connected repository. It does not work in DMs. "GitHub only" is a listed limitation — [Claude Code in Slack](https://code.claude.com/docs/en/slack).
- **[Verified]** The legacy bot was retired effective 2026-10-05 for workspaces connected to a Claude organization. The notice applies regardless of the user's own plan — [same page](https://code.claude.com/docs/en/slack).

**Claude Tag (organization version, public beta)**
- **[Verified]** Team and Enterprise only, not Free, Pro, Max or Ultra. It runs "in an ephemeral sandbox, not on your computer". Channel work bills by usage to an organization balance, not to a seat — [Claude Tag overview](https://claude.com/docs/claude-tag/overview).

**ChatGPT/Codex in Slack**
- **[Verified]** OpenAI's Slack page now covers **@ChatGPT**, which replaces the earlier @Codex mention. Repository work is delegated to a separate **Codex Cloud** task and needs Cloud delegation and a published environment shared with the workspace. Slack Connect channels are unsupported. The page describes no local-machine path — [OpenAI Slack docs](https://learn.chatgpt.com/docs/third-party/slack).
- **Conflict:** a search summary of an older OpenAI page lists Plus, Pro, Business, Enterprise and Edu plus a GitHub account and an environment — [OpenAI, via redirect](https://developers.openai.com/codex/integrations/slack). The current page does not state plans, so **eligibility for an individual plan is unconfirmed**.

**Claude Code channels (local wake)**
- **[Verified]** A channel is an MCP server that pushes events into a running session, and the work happens "on your machine against your real files". Telegram, Discord, iMessage and a localhost demo (fakechat) are included. It is a **research preview**, and events arrive only while the session is open — [channels docs](https://code.claude.com/docs/en/channels).
- **[Verified]** Setup is documented entirely through the terminal with `claude --channels ...`. Plugins require Bun. Pro, Max and Ultra users without an organization skip the admin checks. Auth is claude.ai or a Console API key — [channels docs](https://code.claude.com/docs/en/channels). A search snippet claiming API-key auth is unsupported conflicts with the fetched page; use the fetched page.
- **[Verified]** During the preview, custom channels are not allowlisted and need `--dangerously-load-development-channels`, which works only in an interactive session and is ignored with `-p` or through the Agent SDK. A full-screen warning must be accepted — [channels reference](https://code.claude.com/docs/en/channels-reference.md).
- **[Verified]** Permission prompts pause the session until answered, unless relayed. A channel can declare a permission relay, and anyone who can reply through the channel can approve tool use — [channels docs](https://code.claude.com/docs/en/channels).
- **[Community]** A feature request opened 2026-05-24 asks to expose `--channels` in the desktop app. Its author reports no working route in Desktop v1.7196.0 — [issue mirror](https://claudeissues.com/issue/62021-feature-request-expose-channels-flag-from-claude-code-desktop-app-launch-ui-conf). Current status is unconfirmed, and this is a mirror rather than GitHub itself.

**Codex local wake**
- **[Community]** A third-party package states that an idle Codex thread waits for a human, that Codex has no background hook to start a turn, and that the app-server's `turn/start` can. It runs `codex app-server --listen ...` — [ai-crew-sync](https://docs.rs/ai-crew-sync/latest/ai_crew_sync/codex_wake/index.html). Related: [codex-wake](https://github.com/CochranResearchGroup/codex-wake), [app-server guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/).
- OpenAI's MCP page does not say whether server notifications can start a turn — [OpenAI MCP docs](https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli).

**Mattermost built-in agents**
- **[Verified]** Mattermost's own agent bots reply to @mentions in threads. Channel auto-reply requires **Enterprise Advanced** — [user guide](https://docs.mattermost.com/agents/docs/user_guide.html). These are bots run by the plugin using admin-configured models, not the desktop apps.

### Inferences
- Combining an MCP server with the desktop apps gives "chat-aware agents you prompt", not agents that respond by themselves.
- Mattermost Agents bots almost certainly need a configured LLM provider, which would normally mean an API key. The page I read did not state this outright, so confirm it in the admin docs.
- Scheduled polling inside each app could approximate wake-on-mention, with latency and usage costs. Anthropic documents [session-scoped scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md) (linked from the channels page, not read). Codex automations appeared only in a [third-party doc](https://docsearch.algolia.com/mcp/docs/repo/friuns2/codex-mobile). This approach is unproven.

### Gaps
- No official OpenAI documentation was found on waking a desktop Codex thread from an outside event.
- I did not verify whether the desktop apps can poll a chat room unattended, or how reliably.

## Do agent-to-agent mentions work? Do bot-loop protections or platform rules block bots from triggering each other?

### Takeaway
Out of the box, generally no, because the defaults filter bot-authored messages. Official Claude channel code drops all bot messages, and Mattermost's auto-reply ignores other bots unless opted in. Bot-to-bot chat is achievable only with patched or third-party bridges, and those need deliberate loop protection.

### Cited Findings
- **[Verified, source code]** Anthropic's official Discord channel plugin drops bot messages before any gating: `if (msg.author.bot) return`. Group channels are opt-in and `requireMention` defaults to true — [server.ts](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/discord/server.ts).
- **[Community]** One developer confirmed this block and patched in an `allowBots` list, which took them outside the approved-channel allowlist so that inbound messages were silently dropped. The patch also introduced a security bug, since bots could approve tool permissions; it was fixed afterward. They moved to a hub-and-spoke topology with a server-side token-bucket limiter, and a test mentioning four bots drew three replies in six seconds — [DEV post, dated Aug 3, year not shown](https://dev.to/vladonemo/making-a-fleet-of-claude-code-agents-talk-to-each-other-over-discord-5ei7).
- **[Verified]** Mattermost: posts from other bots do not trigger auto-replies unless the integration opts in with the `activate_ai` post property. Webhook and system posts never trigger them — [user guide](https://docs.mattermost.com/agents/docs/user_guide.html). The page does not address bot-to-bot @mentions.
- **[Community]** A bug report states Slack does not fire `app_mention` for `subtype=bot_message`, so bot-to-bot routing depends on message events. It also reports that mentions in the `<@U...|handle>` form were silently dropped by that project's gateway — [OpenAB issue #800](https://github.com/openabdev/openab/issues/800). I did not confirm this against Slack's API docs.
- **[Community]** Slack frameworks ship self-loop prevention by default — [bolt-python #307](https://github.com/slackapi/bolt-python/issues/307). A Pipedream report describes a loop when Slack marked bot posts as human — [Pipedream thread](https://pipedream.com/community/t/can-the-pipedream-team-resolve-the-inaccuracy-of-the-slackbots-is-bot-parameter-causing-an-infinite-loop/11148).
- **[Verified]** Official Slack docs do not say Claude can be triggered by a bot. The Claude Code in Slack page describes context from "your messages and its own" and says to paste a teammate's text manually — [Claude Code in Slack](https://code.claude.com/docs/en/slack). OpenAI's Slack page does not address bots — [OpenAI Slack docs](https://learn.chatgpt.com/docs/third-party/slack).
- **[Vendor claim]** OpenAB (Discord, Slack and gateways, 832 stars, MIT) advertises bot-to-bot "multi-agent collaboration" and supports Claude Code and Codex through ACP — [repo](https://github.com/openabdev/openab). It launches an ACP-compatible agent process, typically a CLI.
- **[Community]** Open Agent Broker has a bot-trigger setting that is disabled by default — [template](https://zeabur.com/templates/IIAM43.yaml).

### Inferences
- @Claude and @ChatGPT tagging each other in Slack should not be assumed to work. The documented flow is human-initiated, and the context description points to a per-user model.
- On a self-hosted platform, the loop filter lives in the bridge, so the user controls it. That is more flexible, but the user must own loop limits and must keep bot senders away from permission approval.
- Any working design should keep a hard rate limit in code, ignore a bot's own posts, and require explicit mentions.

### Gaps
- I did not test any of this.
- I found no Discord, Mattermost, Zulip or Matrix platform rule that blocks bots from seeing each other's messages. The blocks found are in bridges and plugins. I did not read each platform's API terms.

## Can it be self-hosted locally on a Mac, and what does setup require? What license, editions and free-tier limits apply?

### Takeaway
Mattermost, Rocket.Chat, Zulip and Matrix can all run in some form under Docker on a Mac, but none was confirmed as an officially supported native macOS server. Mattermost Team Edition appears to be the best license fit, Rocket.Chat's MCP is locked behind a paid add-on, and Slack and Discord cannot be self-hosted.

### Cited Findings

**Mattermost**
- **[Verified]** Team Edition is deployed as a single Linux binary with PostgreSQL. Intended for small teams, hobbyists or personal use under 250 activated users, and "not recommended for government or sensitive commercial workloads". The page calls it MIT-licensed and also says the community edition is compiled under AGPLv3, without reconciling these — [editions docs](https://docs.mattermost.com/product-overview/editions-and-offerings).
- **[Verified]** Entry is the Enterprise binary run in free mode: 10,000 channel messages of visible and searchable history across all channels. Listed future limits include 250 agent queries per month and 5 active playbook runs. Community support only — [editions docs](https://docs.mattermost.com/product-overview/editions-and-offerings).
- **[Community]** Entry can be installed by accident, because Team Edition is a separate binary — [Cloudzy](https://cloudzy.com/de/blog/best-self-hosted-slack-alternatives/). A forum thread shows the same confusion — [forum](https://forum.mattermost.com/t/10000-self-host-cap/25374).
- **[Verified, limit]** Repo licensing: Apache-2.0, with an `enterprise` directory under the Mattermost Source Available License, and some features depend on license level — [repo](https://github.com/mattermost/mattermost-plugin-agents). Summaries require Professional; channel auto-reply requires Enterprise Advanced — [user guide](https://docs.mattermost.com/agents/docs/user_guide.html).

**Rocket.Chat**
- **[Verified]** MCP needs the AI add-on license, as above — [docs](https://docs.rocket.chat/docs/mcp-server).
- **[Community, conflicting]** Community Edition user limits: one forum post says 50 users, then read-only; another says no limit — [forum](https://forums.rocket.chat/t/request-for-25-users-limit/20575), [forum](https://forums.rocket.chat/t/community-edition-user-limit/6213). I did not find an official current page.

**Zulip**
- **[Verified]** Production requires Ubuntu or Debian on a dedicated machine or VM, at least 2 GB RAM, about 10 GB free disk, a DNS hostname and email credentials. Other platforms can use the Docker image — [Zulip docs](https://zulip.readthedocs.io/en/stable/production/requirements.html).

**Matrix**
- **[Community]** `matrix-channel-mcp` offers a bundled local homeserver via Docker Compose, with a default URL of `http://localhost:8008` — [Glama](https://glama.ai/mcp/servers/dlvd13ijr8).

**Slack and Discord**
- Both are hosted services, so self-hosting does not apply. Slack free-tier limits were not confirmed from Slack's own pages.

### Inferences
- For a one-person Mac setup, Docker (or Colima) running Mattermost plus PostgreSQL is a plausible path. The docs describe Linux binaries, so on macOS this means Linux containers.
- The Agents plugin's availability on Team Edition is the critical licensing question. The README and blog imply all plans, but the editions page lists agents under Entry and higher and does not mention Team Edition.
- Entry's 10,000-message cap could be reached quickly with chatty agents, because it applies across all channels. Older messages would stay in the database but disappear from view and search.

### Gaps
- Whether the MCP server works on Team Edition, and which editions its tools need. The admin license page was not read.
- I did not read Mattermost's Docker or macOS deployment page, so I cannot say whether a Mac deployment is supported or only tolerated.
- Licenses for Zulip server and Synapse/Element were not confirmed from primary pages in this run.
- Slack free-plan limits (history, app limits) are unconfirmed.

## Which third parties would receive data, and does this satisfy a rule that only Anthropic, OpenAI, Meta and xAI may receive data without permission?

### Takeaway
Slack and Discord fail the rule without permission, because Salesforce/Slack or Discord would hold the messages, and the official Slack cloud flows also add GitHub. A fully local Mattermost, Zulip or Matrix server can satisfy it, provided mobile push, public tunnels, hosted MCP services and telemetry stay off or are checked.

### Cited Findings
- **[Verified]** Slack routes need the Slack app plus a GitHub connection for the Claude coding flow — [Claude Code in Slack](https://code.claude.com/docs/en/slack). The OpenAI flow sends message and thread history to Codex, per a summary of [OpenAI's Slack guide](https://developers.openai.com/codex/integrations/slack); on the current page, replies are readable by channel members — [OpenAI Slack docs](https://learn.chatgpt.com/docs/third-party/slack).
- **[Verified]** Claude channel Discord setup uses Discord's bot platform with Message Content Intent — [channels docs](https://code.claude.com/docs/en/channels).
- **[Verified]** Remote Claude connectors reach servers from Anthropic's cloud — [Anthropic help](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers). Exposing a local server for that route needs public reachability.
- **[Verified]** Rocket.Chat's AI add-on is obtained via Sales, which adds a commercial relationship but is not itself evidence of message sharing — [docs](https://docs.rocket.chat/docs/mcp-server).
- **[Verified]** Zulip production setup asks for email credentials, which may involve an email provider — [Zulip docs](https://zulip.readthedocs.io/en/stable/production/requirements.html).
- **[Vendor]** Vinkius's hosted Matrix MCP would add Vinkius as a processor — [Vinkius](https://vinkius.com/client/claude-code/connect/matrixelement-mcp).

### Inferences

| Route | Non-listed parties likely to receive data | Passes the rule without permission? |
|---|---|---|
| Local Mattermost/Zulip/Matrix, with local MCP | None by design. Agent turns go to Anthropic or OpenAI | Likely yes, if verified as below |
| Slack (any route) | Salesforce/Slack, and GitHub (Microsoft) for cloud code flows | No |
| Discord (any route) | Discord | No |
| Telegram or iMessage channels | Telegram; Apple | No |
| Public tunnel to a local server | Tunnel provider | No |
| Third-party bridge running locally | None if purely local, but its code must be audited | Depends on code |

- Data that reaches Anthropic and OpenAI includes whatever each agent reads from a room. A shared room would therefore pass each vendor's messages to the other vendor. Both are on the allowed list, so this complies, but the user should know about it.

### Gaps
- Not checked: Mattermost, Zulip and Element telemetry defaults, mobile push proxies, update checks, and any Docker Desktop telemetry. These need checking before claiming "no third parties".
- Package registries and image hosts (npm, PyPI, Docker Hub, GitHub) receive download metadata during install. Whether this counts under the rule is the user's call.

## What are the usage signals, doc quality and independent reviews of the platforms and bridges, including complaints?

### Takeaway
Docs are strongest for Mattermost, Claude and OpenAI, though Mattermost's license wording is inconsistent. The bridges are young, and independent reviews are scarce. The clearest independent complaint is the backlash over Mattermost's 10,000-message limit.

### Cited Findings
- **Stars and activity (2026-11-06):**
  - mattermost-plugin-agents: 257 stars, 113 forks, 733 commits — [repo](https://github.com/mattermost/mattermost-plugin-agents).
  - openab: 832 stars, 213 forks — [repo](https://github.com/openabdev/openab).
  - zulip-mcp (monadical): 12 stars, 9 commits — [repo](https://github.com/monadical-sas/zulip-mcp).
  - tether (Discord): 1 star, **archived 2026-02-15** — [repo](https://github.com/thesammykins/tether).
- **Complaints, Mattermost:** a forum thread running from October 2025 to October 2026 includes users calling the cap "Fake Open Source", one reverting the 11.x upgrade, and one leaving after seven years. The workaround offered is Team Edition, a fork ("Mostlymatter") or source edits. No clear staff response is visible — [forum](https://forum.mattermost.com/t/10000-self-host-cap/25374).
- **Complaints, Claude desktop:** reported Code tab bugs include failed sessions and a missing tab — [#30017](https://github.com/anthropics/claude-code/issues/30017), [#45545](https://github.com/anthropics/claude-code/issues/45545), [mirror](https://claudeissues.com/issue/92805-bug-bug-code-tab-missing-entirely-from-claude-desktop-macos-pro-plan). These are individual reports, and I did not confirm whether they are resolved.
- **Channels stability:** Anthropic says the flag and protocol may change — [channels docs](https://code.claude.com/docs/en/channels). Events drop silently if the server is not loaded as a channel, and there is no delivery acknowledgement — [channels reference](https://code.claude.com/docs/en/channels-reference.md). A separate open bug on `--channels` matching (#51845) is cited in the [issue mirror](https://claudeissues.com/issue/62021-feature-request-expose-channels-flag-from-claude-code-desktop-app-launch-ui-conf).
- **Practical account:** the DEV post is the most useful independent build log, and its issues are listed above — [DEV](https://dev.to/vladonemo/making-a-fleet-of-claude-code-agents-talk-to-each-other-over-discord-5ei7). It is one author's experience.
- **Docs issue:** Mattermost's editions page has the unresolved MIT/AGPL wording — [editions docs](https://docs.mattermost.com/product-overview/editions-and-offerings).

### Inferences
- Stars for `mattermost-plugin-agents` understate its significance, since it is a first-party plugin for an established platform. Stars for openab may reflect a broader multi-platform audience. Neither count measures reliability.
- "Proven" applies to the chat platforms, not to the agent bridges. No source showed a Claude + Codex + human multi-room setup in sustained use on any of these platforms.

### Gaps
- No install counts, independent benchmarks or formal reviews of these MCP servers were found.
- I did not read comparison blogs such as [Rework](https://resources.rework.com/es/tools/productivity/mattermost-vs-rocket-chat), and some of these are commercially motivated.
- Community sizes for Zulip and Matrix were not collected.

## Per approach: does it satisfy no model API keys and ideally no model CLI, and which part is unproven?

### Takeaway
No verified approach delivers all of it: multi-room chat, automatic wake, agent-to-agent mentions, both desktop apps, subscription billing, no API keys and no CLI. A self-hosted platform with MCP meets the key and CLI constraints but agents must be prompted, while wake-on-mention locally needs CLI processes and preview or unofficial mechanisms.

### Cited Findings
The sources for the facts in this table appear in the sections above. The table itself is a synthesis, so its verdicts are partly inference.

| Approach | No API key? | No model CLI? | Wakes on mention? | Bot-to-bot? | Local files? | Unproven part |
|---|---|---|---|---|---|---|
| Local Mattermost + built-in MCP + both desktop apps | Yes, likely (chat token only; subscription auth) | Yes for Codex's config route; the Claude route likely needs a local wrapper (a non-model tool) | **No** | No (each is prompted) | Yes, through each app | Claude Desktop local wiring, Codex connection, Team Edition eligibility, MCP without LLM config |
| Mattermost Agents built-in bots | Likely **no** (provider configuration) | Yes | Yes | Only with `activate_ai` for auto-reply | No | Key requirement, and whether subscriptions can be used at all |
| Zulip or Matrix + community MCP + desktop apps | Yes (bot/access token only) | Yes | **No** | No | Yes, through each app | Maintainer reliability; setup untested |
| Local chat + Claude Code custom channel | Yes (claude.ai login) | **No** (needs `claude`, interactive) | Yes, for Claude | Needs a bridge that accepts bot senders | Yes | Dev flag, preview changes, keeping the session alive, permissions |
| Local chat + Codex app-server bridge | Yes if using Codex's subscription login (not confirmed per project) | **No** (needs `codex app-server`) | Yes, by third-party report | Bridge-dependent | Yes | Unofficial protocol use; no ready Mattermost bridge found |
| Discord + official Claude channel | Yes | **No** | Claude only | **Blocked** by `msg.author.bot` unless forked | Yes | Fork leaves the allowlist; fails data rule |
| Discord or Slack + OpenAB | Not stated by the repo | **No** in general (launches agent CLIs) | Vendor claim: yes | Vendor claim: yes | Yes, if run locally | Reliability; fails data rule |
| Slack + Claude + ChatGPT/Codex official apps | Yes | Yes | **Yes** | Not documented; do not assume | **No** (cloud, GitHub) | Plan eligibility; fails data rule; desktop apps not involved; Claude Tag excludes individual plans |

### Inferences
- **Direct answer to the objective:** a proven chat platform with existing MCP gives a real multi-room workspace that both desktop apps can likely read and write on subscriptions, but agents will not respond on their own. Automatic participation is the gap, and it is the same gap on every platform, because the limit sits in the desktop apps rather than in the chat server.
- **Best-fit candidate on current evidence:** local Mattermost Team Edition with the Agents plugin's MCP server, used in prompt-driven mode. A short hands-on test should come before any commitment.
- **If automatic wake is essential, the user must relax "no CLI".** That means Claude Code with a custom channel and Codex app-server, plus a self-written or audited bridge with loop limits. I found no ready-made Mattermost bridge covering both agents.
- **Suggested spike order:**
  1. Install Team Edition plus the plugin, and confirm MCP works with no LLM key.
  2. Connect the Codex app.
  3. Connect the Claude desktop app through a local wrapper.
  4. Test scheduled polling in each app.

### Gaps
- No source demonstrates the full human + Claude + Codex setup on any of these platforms.
- Whether scheduled desktop tasks can provide acceptable near-real-time polling on subscription limits is unknown.
- Subscription terms for automated or unattended use of the desktop apps and CLIs were not reviewed.
