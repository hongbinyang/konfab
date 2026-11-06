# Packaged group chat apps for humans and multiple AI agents (state as of 2026-11-06)

Evidence labels used throughout:
- **[Verified]**: read directly from source code, a GitHub API response, a release listing, a privacy policy, or a store listing on 2026-11-06.
- **[Vendor]**: a claim on a marketing page, press release, sponsored post, or maker comment.
- **[Independent]**: a third-party review or user comment.
- **Inference** items appear only under "Inferences".

No product was installed or run. Nothing here is hands-on testing.

Summary table (details and sources in the sections below):

| Product | Real local Claude + Codex agents? | No API key? | No CLI? | No unapproved third party? | Multi-room with human control? | Direct-use verdict (inference) |
|---|---|---|---|---|---|---|
| Buzz (Block) | Yes, through app-managed harnesses | Yes for Claude and Codex in the current preview | No: the app downloads its own copies | Only with a self-hosted local relay; hosted communities send data to Block | Yes | Closest fit, but pre-1.0 and rough |
| Bloome | Vendor says yes, mechanics undocumented | Unclear | Probably no | No | Yes | Plausible, fails the privacy constraint |
| Persemble | Through CLI subprocesses; tool access undocumented | Conflicting docs | No in CLI mode | Largely yes | Not shown (sessions) | Local debate app, not Slack-like |
| Agents Council (MrLesk; a possible "Council") | Yes, through MCP in real sessions | Yes | No | Yes | No (sessions) | Local debate tool, not Slack-like, dormant |
| Council. (xEscapeVelocity) | No, models only | No | Yes | Depends on provider chosen | Not shown | Fails |
| Parley AI | No, models only | Partly (hosted keys) | Yes | No | Rooms, but one human and models | Fails |
| AgentMeet | Any HTTP-capable agent; spectator-first | Yes | Needs a tool-capable agent | No privacy policy found | No | Fails |
| im-bot | Claude and Codex not documented | Depends on agent | No | No | Rooms yes | Fails on current docs |
| Teamily AI | No evidence, hosted agents | Yes | Yes | No | Group chats | Fails |
| Chord | No, models only | BYOK or proxy | Yes | No | Group chats | Fails, private beta |
| Hazel | No, built-in bots | Unknown | Yes | No | Yes for humans | Fails without building your own bridge |

## How do agents connect, and can the Claude and Codex desktop apps participate using existing subscriptions?

### Takeaway
None of the ten documents the Claude desktop app or Codex desktop app joining as a chat participant. Buzz comes closest to the subscription requirement: its current preview installs app-managed Claude and Codex runtimes and signs in through the browser with a Claude or ChatGPT account. Parley's Claude Desktop support only lets Claude call Parley as a tool.

### Cited Findings

**Buzz (Block)**
- [Verified] Current desktop harness table: Claude needs "a Claude account"; you click **Install Claude** to download Buzz's own copy (about 250 MB), then sign in through the browser. Codex needs "a ChatGPT or OpenAI account"; you click **Install Codex** (about 130 MB), then sign in. Agents "run on your computer while Buzz is open" — [block/buzz-app README](https://github.com/block/buzz-app)
- [Verified] Desktop code has a Claude subscription login path running `claude auth login --claudeai`, and onboarding names "Claude subscription" and "ChatGPT subscription" — [agent_auth.rs](https://github.com/block/buzz/blob/main/desktop/src-tauri/src/commands/agent_auth.rs); [SetupStep.tsx](https://github.com/block/buzz/blob/main/desktop/src/features/onboarding/ui/SetupStep.tsx)
- [Verified] Conflict: the older headless harness docs say Codex needs `OPENAI_API_KEY` ("use an OpenAI API key, not a ChatGPT subscription") and show `ANTHROPIC_API_KEY` for Claude. This applies to manual `buzz-acp`, not the desktop flow above — [buzz-acp README](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- [Verified] A user reports that a local `claude` runtime is "started by Buzz.app itself (no separate buzz-acp process anymore)" on macOS, and a second commenter reports one Claude Code and one Codex agent started by the app on 0.7.0-preview.230.1 — [block/buzz issue #8684](https://github.com/block/buzz/issues/8684)
- [Verified] Anthropic's terms: third-party developers may not "offer Claude.ai login into their own applications" or route requests through plan credentials on behalf of users, and Agent SDK builders "should use API key authentication." They also say this does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and advertised limits "assume ordinary, individual usage" — [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

**Bloome**
- [Vendor] Claude Code connects "through Bloome's agent protocol, not an official plugin"; you register it as an external agent — [Bloome Claude Code page](https://bloome.im/features/claude-code). The connection is called ACP — [Bloome guide](https://bloome.im/guides/claude-code-team)
- [Vendor] Agents are created "in a cloud sandbox or through a local CLI such as Claude Code or Codex" — [Product Hunt](https://www.producthunt.com/products/bloome-2)
- [Independent] Agents can be added from the cloud or the user's PC, up to 16 — [Alphr, 2026-09-23](https://www.alphr.com/can-bloome-ai-allow-ai-agents-to-collaborate/)
- [Vendor] Usage is credit-based; the pages I read do not say whether Claude Code uses your subscription — [Bloome Claude Code page](https://bloome.im/features/claude-code)

**Persemble**
- [Verified, vendor policy] Claude CLI, Gemini CLI, and Codex CLI "run as local processes"; each manages its own authentication, and the app does not access CLI credentials — [Persemble privacy policy, 2026-03-05](https://persemble-redirect.pages.dev/en/privacy.html)
- [Vendor] Conflict: the home page offers "free CLI tools" as a no-cost option — [Persemble site](https://persemble-redirect.pages.dev/) — but the download page says an API key from OpenAI, Anthropic, or Google is required ("at least one") and CLI is optional — [Persemble download page](https://persemble-redirect.pages.dev/en/download.html)

**Parley AI**
- [Vendor] Seven models work without your own key, and BYOK unlocks unlimited access — [AlternativeTo](https://alternativeto.net/software/parley-ai/about/)
- [Vendor docs] Parley is an MCP server. Claude Code, Claude Desktop (through `npx mcp-remote`, Node.js required), or Cursor call a `second_opinion` tool, and three outside models answer. Claude does not join a Room as a participant, and Codex is not mentioned — [Parley MCP docs](https://parley.amukin.com/en/mcp)

**"Council" is ambiguous; two candidates**
- [Verified] Council. (xEscapeVelocity) connects "directly using your own API keys"; it lists Groq, OpenRouter, Mistral, Cohere, Gemini, Ollama, and LM Studio — [README](https://github.com/xEscapeVelocity/AI-Conversation-Hub)
- [Verified] Agents Council (MrLesk) is an MCP stdio tool. You add it with `claude mcp add` or `codex mcp add council npx agents-council@latest mcp`, and it requires Node.js or Bun. Summoning Claude or Codex "reuses local CLI authentication where available" — [README](https://github.com/MrLesk/agents-council)

**AgentMeet**
- [Vendor docs] Agents join over plain HTTP with per-agent tokens; no MCP is mentioned — [AgentMeet docs](https://agentmeet.net/docs). Vendor pitch: "No signup, no OAuth, no API key" — [AgentMeet preview deployment](https://agent-meet-git-feature-decisions-protocol-matanraks-projects.vercel.app/)

**im-bot**
- [Vendor] Documented connection is the `im-bot-connector` skill for Hermes Agent or OpenClaw, run with an invite code — [im-bot](https://im-bot.net)
- [Verified] The connector skill describes a supervisord-run Hermes listener and a DeepSeek Harness ACP backend. GitHub code search of the repo returned no hit for "claude" or "codex" — [SKILL.md](https://github.com/dayhappysun/im-bot-connector/blob/main/skills/im-bot-connector/SKILL.md)

**Teamily AI**
- [Vendor] Claude Fable 5 is available to Pro users "with no setup"; Claude Code and Codex are not mentioned — [Teamily blog, 2026-06-09](https://blog.teamily.ai/teamily-ai-brings-agent-teams-to-human-teams/)
- [Vendor] Users connect personal accounts such as Gmail, X, Slack, and GitHub — [Teamily about](https://teamily.ai/about)

**Chord**
- [Vendor] OpenAI, Anthropic, Gemini, and local open-source models via your own API keys or Chord's proxy; no MCP mention — [chord.chat](https://chord.chat)

**Hazel**
- [Vendor] "Built-in AI agents" and custom bots and webhooks; Claude Code, Codex, and MCP are not mentioned — [hazel.sh](https://hazel.sh)
- [Verified] The repo contains `bots/hazel-bot/src/openrouter.ts`, and the changelog mentions "reasoning models through OpenRouter" — [Hazel repo](https://github.com/MapleTechLabs/hazel); [Hazel changelog](https://hazel.sh/changelog)
- Name collision: Hazelchat (hazelchat.co) is an unrelated website-visitor support agent product — [Hazelchat docs](https://hazelchat.co/docs/ai-assistants)

### Inferences
- Buzz's "Claude" and "Codex" are the vendor runtimes under Buzz's control, not your open desktop app windows. The subscription is reused, but not the app or its session.
- Buzz's Claude subscription sign-in sits in a grey area under Anthropic's terms: signing in to an unmodified binary is allowed, but a third-party app that offers the login, using an Agent SDK adapter, is what the same page restricts. Buzz's flow runs Anthropic's own `claude auth login`. I would flag this as an unresolved risk, not a violation. Heavy agent-to-agent traffic could also strain limits that assume "ordinary, individual usage".
- Bloome's local path most likely reuses local CLI login, but this is undocumented.
- Agents Council could technically be added to any MCP-capable client, possibly including the desktop apps, but its docs cover only CLI commands.

### Gaps
- No vendor documents the Codex desktop app as a participant. I did not find a statement that it is impossible, either.
- I did not run Buzz's sign-in flow, so working subscription auth rests on code, README text, and user reports.
- Bloome's install steps and auth are not on the pages I could read.

## Is the "Claude" or "Codex" a real agent with local file and tool access, or only a model over an API?

### Takeaway
Real local agents: Buzz and Agents Council. Probably real but under-documented: Bloome and Persemble's CLI mode. Model calls or hosted agents: Council., Parley, Chord, and, on available evidence, Teamily and Hazel. AgentMeet and im-bot depend on what you attach, and Claude and Codex are not their documented path.

### Cited Findings
- [Verified] Buzz local agents "work in `~/.buzz` by default and can run commands and edit files there" — [buzz-app README](https://github.com/block/buzz-app). Remote "Builderlab agents" run when the desktop is off and "cannot open files on your computer" — [buzz-help.md](https://github.com/block/buzz-app/blob/main/docs/buzz-help.md)
- [Verified] An open Buzz item requests per-agent extra folders at session start (`additionalDirectories`) — [block/buzz issues search](https://github.com/block/buzz/issues?q=additionalDirectories)
- [Vendor] Bloome's Claude Code "can help produce a change, while teammates keep review and approval in the thread"; local file access is not described — [Bloome](https://bloome.im/features/claude-code)
- [Vendor] Persemble describes personas, autonomous discussion, and memory. File or tool access is not described — [Persemble site](https://persemble-redirect.pages.dev/)
- [Verified] Agents Council bridges "existing, active sessions" of Claude Code and Codex, so agents keep their own context and tools — [README](https://github.com/MrLesk/agents-council)
- [Verified, vendor policy] Parley relays messages and history to the selected provider; this is an API model pattern — [Parley privacy](https://parley.amukin.com/en/privacy)
- [Vendor] Teamily agents can act through connected accounts, for example sending email or making reservations, on a hosted platform; local file access is not mentioned — [Teamily about](https://teamily.ai/about)

### Inferences
- Buzz's default `~/.buzz` working directory means pointing agents at an existing repository is an extra configuration step. I did not confirm the exact setting.
- Persemble's Claude CLI mode may expose tools, but the app presents a persona-debate model; assume no repository workflow until tested.

### Gaps
- Persemble's CLI invocation, tool permissions, and sandboxing are undocumented on pages I read.
- Teamily and Hazel do not state which model provider or runtime backs each agent.

## Does it support multiple rooms or channels, with topics and human-controlled per-room membership?

### Takeaway
Buzz is the only product with verified Slack-like channels, private access, and per-channel agent membership. Bloome and Teamily offer group chats and threads under a hosted model. Hazel has channels for humans. The rest are single-thread, session-based, or AI-only rooms.

### Cited Findings
- [Verified] Buzz: channels, threads, DMs, private channels, and "Add an agent to a channel the same way you add a person" — [block/buzz README](https://github.com/block/buzz). Channel access can be Private, View only, or Public, with members managed under People — [buzz-help.md](https://github.com/block/buzz-app/blob/main/docs/buzz-help.md)
- [Verified] Buzz topics are not fully confirmed: a July 2026 write-up says `set_channel_topic` returned NotImplemented — [Developers Digest](https://www.developersdigest.tech/blog/buzz-block-agent-native-messaging-nostr). The feature may have changed since. The same applies to an older README note that the relay had no REST or event API for channel members — [buzz-acp README](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- [Vendor] Bloome: group chats, DMs, threads; agents appear in the member list; roles and permissions are not described — [Bloome](https://bloome.im/features/ai-agents-in-group-chat)
- [Independent] Bloome: all invited members see a single chat's full history — [Alphr](https://www.alphr.com/can-bloome-ai-allow-ai-agents-to-collaborate/)
- [Vendor] Persemble: sessions with purposes and project memory; "rooms" are not mentioned — [Persemble site](https://persemble.ai/en/index.html)
- [Vendor] Parley: up to six models in one Room — [AlternativeTo](https://alternativeto.net/software/parley-ai/about/). Its home page describes four AI characters and no human participants — [Parley](https://parley.amukin.com)
- [Verified] Agents Council has a session sidebar with a composer and summon entry, not channels — [README](https://github.com/MrLesk/agents-council)
- [Vendor docs] AgentMeet: rooms with kick and lock endpoints controlled by a creator token — [AgentMeet docs](https://agentmeet.net/docs)
- [Vendor] im-bot: rooms where people and agents share a thread; each room is a persistent agent session — [im-bot](https://im-bot.net)
- [Vendor] Chord: group chats up to 20 people — [chord.chat](https://chord.chat)
- [Vendor] Hazel: organized channels and DMs, unlimited on the free plan — [hazel.sh](https://hazel.sh)

### Inferences
- For the stated Slack-like requirement, only Buzz clearly qualifies among products with local agents.

### Gaps
- Current Buzz status of `set_channel_topic` and member-management APIs in 0.7 previews was not confirmed.
- I did not check Teamily's or im-bot's per-room membership UI.

## Can agents talk directly, debate, and review code on local repositories?

### Takeaway
Buzz documents agent-to-agent dispatch and handoffs but has open bugs on who can wake an agent. Agents Council is purpose-built for peer review across sessions. Bloome claims it. Persemble, Parley, and Council. support model debate only, without evidence of repository work.

### Cited Findings
- [Verified] Buzz: agent-to-agent messages remain as collapsed history showing "dispatches, handoffs, and results"; saved teams up to 32 members can be mentioned together — [buzz-help.md](https://github.com/block/buzz-app/blob/main/docs/buzz-help.md)
- [Verified] Buzz open bug (filed 2026-10-29): after a desktop update, a local Claude Code agent "wakes only on @mentions from its owner", with confirming reports including a 0.7.0-preview.245.1 deployment — [issue #8684](https://github.com/block/buzz/issues/8684)
- [Verified] Other open Buzz issues: `buzz-acp` stalls background tool results for up to 10 minutes; system prompts not reaching `claude-agent-acp` in 0.5.22 with replies silently dropped; remote agents missing from macOS @mention autocomplete in v0.5.26 — [block/buzz issues](https://github.com/block/buzz/issues?q=buzz-acp)
- [Verified] Buzz has a bundled Codex review tool and a "Claude reviews" path needing a `claude setup-token` token — [buzz-help.md](https://github.com/block/buzz-app/blob/main/docs/buzz-help.md); [bundled Codex README](https://github.com/block/buzz-app/tree/main/src/bundled/codex)
- [Verified] Buzz's git hosting backend was listed as "being wired up" on the block/buzz README — [block/buzz](https://github.com/block/buzz)
- [Verified] Agents Council: "brainstorm or peer-review the matter", then you take over the session — [README](https://github.com/MrLesk/agents-council)
- [Vendor] Bloome: agents delegate, share context, and work in parallel; implementation is not explained — [Bloome](https://bloome.im/features/ai-agents-in-group-chat)
- [Vendor] Persemble: agents speak unprompted, react, and a facilitator guides — [Product Hunt](https://www.producthunt.com/posts/1093894)
- [Verified] Council.: Auto-Debate mode with on/off control — [README](https://github.com/xEscapeVelocity/AI-Conversation-Hub)
- [Vendor] im-bot agents respond only when @mentioned, with a maximum turn limit — [Product Hunt](https://www.producthunt.com/posts/im-bot)

### Inferences
- The wake bug matters less for one owner with their own agents, because the owner's mentions work. Whether one agent's @mention wakes another in the current preview needs a hands-on test; the docs imply dispatch works, the issue suggests the gating is unsettled.

### Gaps
- No independent, hands-on report of Claude and Codex debating or cross-reviewing a local repo in any of these products was found.

## Is it local or hosted, and which third parties receive data?

### Takeaway
Only Buzz (self-hosted relay on your Mac), Agents Council, and Persemble can avoid a new vendor receiving chat data. Bloome, Parley, Teamily, im-bot, Chord, AgentMeet, and hosted Hazel all put chat on the vendor's servers or a gateway.

### Cited Findings
- [Verified] Buzz: the app defaults to `ws://localhost:3000` in the block/buzz README, with Docker Compose running Postgres, Redis, and MinIO; events are stored in Postgres — [block/buzz](https://github.com/block/buzz). A Railway deploy option and hosted communities also exist; the newer app steers new users to join or create a community — [buzz-app](https://github.com/block/buzz-app)
- [Independent] Buzz is self-hostable or available as Block's managed version — [Decrypt, 2026-07-22](https://decrypt.co/374026?amp=1)
- Buzz hosted privacy: buzz.xyz/privacy returned 404 on my fetch; the page text I could retrieve showed no policy link — [buzz.xyz](https://buzz.xyz)
- [Verified, vendor policy] Bloome stores messages and files on its servers (AWS Oregon), Cloudflare stores media, and it uses analytics partners and Stripe. AI conversations go to the selected provider among OpenAI, Anthropic, Google, Moonshot, DeepSeek, Zhipu, MiniMax, and Xiaomi. Bloome says it does not train on content and instructs providers not to "where contractually possible" — [Bloome privacy, updated 2026-06-26](https://bloome.im/legal/privacy-policy)
- [Verified, vendor policy] Persemble: local SQLite, Keychain, no proxy, no analytics; LemonSqueezy receives license keys for validation; only selected providers receive prompts — [Persemble privacy](https://persemble-redirect.pages.dev/en/privacy.html). Conflict: the site says no license and "$0 Forever" — [Persemble site](https://persemble.ai/en/index.html)
- [Verified, vendor policy] Parley: Google Cloud and Firebase, Stripe, Resend, Google Analytics (structural events only), and providers including Google, xAI, Mistral, Qwen, Cohere, PLaMo, Upstage, and SEA-LION; it does not address provider training — [Parley privacy, updated 2026-10-29](https://parley.amukin.com/en/privacy)
- [Verified] Agents Council: state at `~/.agents-council/state.json`, "Private & Local" — [README](https://github.com/MrLesk/agents-council)
- [Verified] Council.: keys and history stored locally, with direct provider calls — [README](https://github.com/xEscapeVelocity/AI-Conversation-Hub)
- [Vendor, creator post] AgentMeet: FastAPI and Postgres backend with Supabase Realtime; open room creation without auth; rate limiting incomplete — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1rt2sj1/snapshots/2026-03-16T18%3A44%3A56.743259Z). Docs put `agent_token` in a query parameter and state nothing on retention — [AgentMeet docs](https://agentmeet.net/docs)
- [Verified, vendor policy] im-bot: messages stored in the US; Paddle and OAuth providers; no legal entity named; deletion within 30 days, backups up to 90 — [im-bot privacy, 2026-06-30](https://im-bot.net/privacy/). A separate mainland China endpoint runs on Aliyun ECS — [SKILL.md](https://github.com/dayhappysun/im-bot-connector/blob/main/skills/im-bot-connector/SKILL.md)
- [Verified, vendor policy] Teamily: stores prompts, messages, memory, optional device contacts; Google Analytics, Stripe, RevenueCat, cloud hosts; unnamed "language model providers"; data used for improving "our AI models" — [Teamily privacy, updated 2026-11-06](https://teamily.ai/about/privacy-policy). App labels show data used to track you (Purchases, Identifiers) and User Content linked to you — [App Store](https://apps.apple.com/app/id6761445638)
- Chord: the proxy option implies vendor routing — [chord.chat](https://chord.chat). The privacy page is a PDF viewer whose text I could not retrieve — [Chord privacy](https://chord.chat/privacy.html)
- [Verified] Hazel: runs on Cloudflare Workers, Durable Objects, and R2 — [Hazel repo](https://github.com/MapleTechLabs/hazel). Its policy names Hazel Technologies Inc., no AI providers, and was last updated 2024-12-14, predating the AI features in the changelog — [Hazel privacy](https://hazel.sh/privacy)

**Constraint check: no API keys, ideally no CLI, no third parties beyond Anthropic, OpenAI, Meta, or xAI**

| Product | No API keys | No CLI | No unapproved third parties |
|---|---|---|---|
| Buzz | Satisfied for Claude and Codex through account sign-in (per docs and code, not tested) | Not satisfied: app-managed copies of the vendor runtimes, though no manual install | Satisfied only with a local self-hosted relay; not with hosted communities (Block) or Railway |
| Bloome | Unverified | Likely not satisfied for local agents | Not satisfied (Bloome, AWS, Cloudflare, analytics) |
| Persemble | Only if CLI mode works without a key; docs conflict | Not satisfied in the keyless path | Satisfied apart from possible LemonSqueezy license check |
| Agents Council | Satisfied | Not satisfied | Satisfied |
| Council. | Not satisfied | Satisfied | Satisfied only with approved providers or local models |
| Parley | Partly satisfied (hosted keys, paid by credit) | Satisfied | Not satisfied |
| AgentMeet | Satisfied | Not satisfied in practice | Not satisfied (vendor servers, Supabase) |
| im-bot | Unverified for Claude and Codex | Not satisfied | Not satisfied |
| Teamily | Satisfied | Satisfied | Not satisfied |
| Chord | Satisfied only through proxy | Satisfied | Not satisfied |
| Hazel | Unverified | Satisfied | Not satisfied (Cloudflare, likely OpenRouter); self-hosting unverified |

### Inferences
- Even with a local Buzz relay, Goose and similar paths could add providers, so restrict agents to the Claude and Codex harnesses. Also check whether the app contacts Block services for updates and other features, because the app self-updates.
- Hazel's self-host claim is weak: the Cloudflare-based stack is not a simple local install.

### Gaps
- Buzz's hosted-community privacy policy and operator terms could not be retrieved. Help docs refer to "Builderlab" hosting; its relationship to Block is unverified.
- I did not capture network traffic from any app.

## License, pricing, availability, latest release, and usage signals

### Takeaway
Buzz has by far the largest signals and active daily builds. Bloome, Persemble, Parley, im-bot, AgentMeet, and Council. show almost no public traction. Chord looks dormant and is in private beta. Agents Council has had no commits since February 2026.

### Cited Findings (all statistics read 2026-11-06 unless stated; Product Hunt numbers as displayed that day)
- **Buzz** [Verified]: block/buzz Apache-2.0, 36,776 stars, 4,888 forks, 3,790 open issues and PRs, created 2026-03-06, pushed 2026-11-06, latest desktop-v0.5.28 on 2026-10-09 — [GitHub](https://github.com/block/buzz). block/buzz-app Apache-2.0, 105 stars, created 2026-09-10; v0.7.0-preview.249.1 released 2026-11-06, labelled "Buzz 1.0 is in beta", no stable channel, macOS builds signed and notarized — [GitHub](https://github.com/block/buzz-app). Product Hunt launch 2026-07-24: 166 upvotes, 13 comments, #8 — [Hunted.space](https://hunted.space/product/buzz-3). Free and open source; no price given for managed version — [Decrypt](https://decrypt.co/374026?amp=1)
- **Bloome**: free to start, credit top-ups — [Bloome](https://bloome.im/features/ai-agents-in-group-chat). Apps for macOS, Windows, iOS, Android — [TestingCatalog, sponsored, 2026-06-30](https://www.testingcatalog.com/bloome-launches-chat-platform-for-ai-agent-teams/). Product Hunt: 0 points, 1 follower — [Product Hunt](https://www.producthunt.com/products/bloome-2). No App Store rating found.
- **Persemble**: free, proprietary status not stated; v1.1.0 released 2026-05-09; macOS 14+; about 14 MB — [download page](https://persemble-redirect.pages.dev/en/download.html). Product Hunt: 0 points, 2 followers, no reviews — [Product Hunt](https://www.producthunt.com/posts/1093894).
- **Parley AI**: proprietary freemium — [AlternativeTo](https://alternativeto.net/software/parley-ai/about/). Price conflict: AlternativeTo lists $9 to $39 per month, while the site lists Parley Plus at $4.99 per month — [Parley](https://parley.amukin.com). AlternativeTo: 1 like, added 2026-09-16. Web and Chrome extension; no Mac app.
- **Council.** [Verified]: GPL-3.0, 4 stars, 2 forks, last push 2026-06-26, v1.3.8 on 2026-06-20; release assets shown are Windows and Android only — [GitHub](https://github.com/xEscapeVelocity/AI-Conversation-Hub). Product Hunt: 4 upvotes, 9 followers — [Product Hunt](https://www.producthunt.com/products/council-3).
- **Agents Council** [Verified]: MIT, 74 stars, 23 forks, "Experimental", last commit 2026-02-22, latest listed release v0.4.0 on 2026-01-18 — [GitHub](https://github.com/MrLesk/agents-council).
- **AgentMeet**: free; "Open Source Coming Very Soon" with no repo link found; a canonical site at agentmeet.net, and I read a preview deployment of its home page — [preview page](https://agent-meet-git-feature-decisions-protocol-matanraks-projects.vercel.app/). Search summary showed a G2 profile with no reviews; G2 blocked my direct fetch — [G2](https://www.g2.com/sellers/agentmeet).
- **im-bot**: maker says free tier has 3 agents and 100 contacts — [Product Hunt](https://www.producthunt.com/posts/im-bot). Plan prices did not load — [pricing](https://im-bot.net/pricing). Connector GPL-3.0, 0 stars, created 2026-06-23, pushed 2026-11-03 — [GitHub](https://github.com/dayhappysun/im-bot-connector). Service code license unknown. Vote conflict: 1 upvote on Product Hunt versus 3 on [Hunted.space](https://www.hunted.space/product/im-bot).
- **Teamily AI**: App Store 4.5 from 8 ratings, version 2.1.5, iPhone and Mac; IAP listed at Plus $28.99 per month, Premium $129.99, Pro $289.00 per month — [App Store](https://apps.apple.com/app/id6761445638). Public launch 2026-07-08 per company blog; over 10,000 beta users in two weeks per a Forbes-sourced company post (not independently checked) — [Teamily blog](https://blog.teamily.ai/teamily-ai-brings-agent-teams-to-human-teams/).
- **Chord**: private beta with waitlist — [chord.chat](https://chord.chat). Product Hunt launches 2025-06-18 and 2025-07-25, unlabeled numbers 16/157 and 9/66, 172 followers — [Product Hunt](https://www.producthunt.com/products/chord-multiplayer-ai-chats/launches). Directory page last updated 2025-07-08 — [AIPure](https://aipure.ai/products/chord-multiplayer-ai-chats).
- **Hazel** [Verified]: FSL-1.1-ALv2 (source-available with future Apache conversion, not OSI open source, despite "open source" marketing), 733 stars, 58 forks, last commit 2026-11-05, v1.0.2 on 2026-04-24 with macOS arm64 DMG — [GitHub](https://github.com/MapleTechLabs/hazel). Public beta, free for now — [OpenAlternative](https://openalternative.co/hazel). Changelog's latest entry I saw was 2026-02-23 — [changelog](https://hazel.sh/changelog).

### Inferences
- Status judgments: Buzz active and pre-1.0; Chord not generally available and possibly dormant (no dated activity after mid-2025 that I found); Agents Council dormant for over eight months, not declared abandoned; Council. inactive since June 2026, too recent to call abandoned; Persemble's latest visible release is six months old.
- Teamily's $289 Pro monthly price may be a store data oddity, so confirm in the app.

### Gaps
- Persemble's and Chord's exact licenses were not found. No Mac App Store listing was found for Persemble (the site does not mention one).
- Bloome's team, legal entity jurisdiction, and App Store rating were not found.

## Documentation quality and what independent reviews and users say

### Takeaway
Independent evidence is thin across the board. Buzz has deep but sprawling docs and real bug reports. Most others have only launch posts or sponsored coverage, with no credible user reviews.

### Cited Findings
- [Verified] Buzz docs: strong getting-started README and long help doc, but two parallel apps (0.X and 1.0 beta) and older docs that conflict with current flows — [buzz-app](https://github.com/block/buzz-app); [buzz-acp](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- [Independent] Buzz: Developers Digest calls it "not a mature product", suggesting waiting if you want a Slack replacement today; it cites an unimplemented `send_dm` and missing production rate limiter as of the July release — [Developers Digest](https://www.developersdigest.tech/blog/buzz-block-agent-native-messaging-nostr)
- [Independent] Buzz HN Show HN mirror: 21 points, positive comments; the author called it "still early days and still very, very rough" — [HN mirror](https://sites-zeta.vercel.app/item/48632977)
- [Independent] Buzz single-relay critique: one relay is the source of truth, a single point of failure — [CSDN review](https://adg.csdn.net/6a62eb4710ee7a33f291f739.html). Product Hunt commenters asked about key recovery and rotation and permission isolation — [Hunted.space](https://hunted.space/product/buzz-3). The app states "Buzz doesn't back up your key" — [buzz-app](https://github.com/block/buzz-app)
- [Independent] Bloome: Product Hunt comment says "still beta", uneven discovery feed, early monetization, sometimes glitchy — [Product Hunt](https://www.producthunt.com/products/bloome-2). Alphr criticizes opaque credit pricing — [Alphr](https://www.alphr.com/can-bloome-ai-allow-ai-agents-to-collaborate/). TestingCatalog is labeled sponsored and launch stories are press releases — [TestingCatalog](https://www.testingcatalog.com/bloome-launches-chat-platform-for-ai-agent-teams/)
- [Independent] AgentMeet Reddit commenters noted the lack of test results and the need for identity and governance controls — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1rt2sj1/snapshots/2026-03-16T18%3A44%3A56.743259Z). Date conflict: one summary places the post in March 2026, another about 237 days before the snapshot.
- im-bot: a Product Hunt commenter asked for per-agent budgets to prevent runaway quota use — [Product Hunt](https://www.producthunt.com/posts/im-bot)
- Parley's MCP docs are specific on commands, limits, and data flow — [Parley MCP](https://parley.amukin.com/en/mcp). The Persemble "Watch Demo" link was a placeholder when read — [Persemble site](https://persemble-redirect.pages.dev/)
- Teamily's coverage is largely press release or contributor content, such as [GeekWire contributor content](https://www.geekwire.com/contributor-content/every-major-ai-company-now-ships-an-always-on-agent-few-have-solved-the-team/).

### Inferences
- Overall ranking for the user's stated goal: Buzz with a local relay is the only credible direct-use candidate, and it still fails "no CLI" in the strict sense and carries preview-stability risk. If hosted data is acceptable, Bloome could be tested but its auth is undocumented. Agents Council and Persemble suit debate use only, not a Slack-like workspace.
- A user building their own app would be competing mainly with Buzz; the rest do not meet the core requirement.

### Gaps
- I found no credible Reddit threads or long-term user reviews for any product. Searches may have missed them.
- I could not read HN's site directly; the Buzz thread came through a mirror.
- Claims on Hazel self-hosting and agent configuration were not verified.
