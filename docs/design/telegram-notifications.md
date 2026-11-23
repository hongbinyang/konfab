# Phone notifications through Telegram

**Status:** implemented on a branch, in review. Tested with a local stand-in only; nothing has been sent to Telegram.

## Goal

When the lead is away, Konfab sends a short one-way notice to the lead's own Telegram chat. It is off until the lead sets it up.

## Setup

Each step that contacts Telegram says so and waits for a yes. Nothing is sent or read before that. Setup is a terminal command that asks at a real terminal; the page and agent tools can't run it. An agent that can run commands as the lead could still try, so it isn't a security boundary against one.

1. The lead creates a **new bot only for Konfab** with Telegram's @BotFather.
2. `npm run setup -- --telegram` asks for the bot token with hidden input and checks it (`getMe`). If the bot has a webhook, it belongs to something else: setup stops and changes nothing.
3. Setup shows a one-time code and asks the lead to send it to the bot from their phone, within 5 minutes. It then reads the bot's waiting messages (`getUpdates`) and accepts only a private chat whose own user sent exactly that code. Everything else is ignored and not kept.
4. Setup shows that chat's name and asks "Send Konfab's notices here?".
5. **Send a test** is a separate yes, and turning notices on is another. `--telegram --remove` deletes the token and the chat number.

**Replacing a setup.** A new token goes into the Keychain slot that the current setup doesn't use. The current setup keeps sending, with its own token and chat, until the last question is answered; then one file is replaced in one step, and the old token is removed. On a no, a failure or a failed write, the new token is removed and the current setup is as it was. If setup is killed, the unused token stays in its slot until the next setup or `--remove`. The settings name the slot, the bot and the setup: a token for another bot is never used, and records of an earlier setup aren't either. With `KONFAB_TELEGRAM_TOKEN`, changing the variable to another bot stops notices until setup is run again.

**Other uses of a bot.** The reads never confirm messages (no `offset`), so they stay for whatever else would read them. Reading can still interrupt another program that is reading the same bot at that moment, and Telegram refuses two readers. That is why a new bot is required, and why setup stops when Telegram says the bot is in use elsewhere. Setup never deletes a webhook. The lead can skip all reading by typing the chat number instead; then the test message is the only proof of who receives it, and notices can't be turned on until the lead confirms it arrived.

## Where the token and chat number are

| Where                                          | Who can reach it                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token: macOS Keychain                          | Programs running as the lead that macOS lets read that item. **An agent that can run commands as the lead may be able to**, as with the GitHub token |
| Token: `KONFAB_TELEGRAM_TOKEN` (other systems) | Any program running as the same user                                                                                                                 |
| Token in the running server                    | The server's memory. Konfab gives it to no agent tool, page, export, database, backup or log                                                         |
| Chat number: `~/.konfab`, readable by the lead | Programs running as the lead                                                                                                                         |

With the token, someone could send messages as this bot and read what is sent to it. They couldn't reach the lead's Telegram account. The bot can be revoked in @BotFather.

Agents get no tool that sends, sets up or changes notices. What they can do is cause an event, such as mentioning @lead, within the limits below.

## What is sent

| When                                                                                                           | Text                                     |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| An agent mentions @lead                                                                                        | Konfab: a room needs you.                |
| A permission request is waiting                                                                                | Konfab: a permission request is waiting. |
| An agent dropped, its run ended, it reported a refused call or no allowance, or automatic continuation gave up | Konfab: a room has stopped.              |
| More than one of these                                                                                         | Konfab: your rooms need you.             |

Never message text, files, agent or room names, links, paths or sign-in codes. Room names can be turned on separately. Telegram carries the notices, so it sees them, the chat and when they are sent.

## When

- Only while the lead is away: no click, key or scroll on the Konfab page for 10 minutes (adjustable). A page that is only left open marks messages as read, so that alone doesn't count as seen. After a server start the lead counts as there.
- Notices within a minute become one; at most one per room in 10 minutes and 20 a day; quiet hours can be set.
- An event the lead has already seen while active, answered or decided isn't sent. Nothing from before notices were turned on, or while they were off, is sent.
- Pausing a room, or **Take a break**, stops its notices. A switch on the page stops them all.

## Delivery and failures

- HTTPS to `api.telegram.org` only, no redirects, 10-second limit. The token is part of that service's address, so addresses and raw errors are never logged or shown.
- What certainly wasn't delivered is tried again, as late as Telegram asks; after three tries, every 10 minutes. After a refusal (bad token, blocked bot, missing chat) nothing more is tried until the lead selects **Try again**, changes the switch or runs setup. The page shows "Phone notices aren't getting through" with the reason in plain words. Posting in rooms never waits for a notice.
- A notice that may already have been delivered isn't sent again, so one can be lost but not repeated. What was tried is recorded without its text, so a restart doesn't send old notices.
- One-way: after setup Konfab never reads messages from Telegram, so nothing sent to the bot can control Konfab.

## Tests

No test contacts Telegram. A local stand-in: setup without a yes, a wrong or late code, a group, a forwarded code, a bot with a webhook or another reader, typing the chat number, each event, away and back, batching and limits across a restart, quiet hours, refusals, "try again later", no answer, and that the token, chat number and room content appear in no log, page, export or agent reply. Real delivery is checked once, by the lead, with the test step. How Telegram answers is taken from its documentation and is confirmed in that check.
