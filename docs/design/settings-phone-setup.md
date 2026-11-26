# Settings, phase 2: setting up phone notices in the page

**Status:** reviewed; parts A and B are built, with stand-ins only; Paste here (C and D) isn't. No Keychain test was run for it, and K1 to K7 wait for the lead. It makes the part "Phone notices in the page" of [Settings](settings.md) concrete, and changes three things there (marked **Changed**).

## What the lead gets

**⚙ Settings → Phone notices**, and **Set up…** under **Lead**:

| Step   | The lead                                                      | Konfab                                                                               |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 Bot  | pastes the token, agrees that Konfab contacts Telegram        | checks the form, asks Telegram for the bot's name and whether something else uses it |
| 2 Chat | sends the shown code from the phone                           | waits up to 5 minutes for exactly this code                                          |
| 3 Test | reads whose chat it is, **Send a test**, says whether it came | sends "Konfab: test"                                                                 |
| 4 Done | **Turn on**, or **Finish, off**                               | stores the token, writes the setup in one step                                       |

Later: on and off (as now), **Send a test**, **Set up again**, **Remove**. The command line gets `--status`, `--on`, `--off`, `--test` and `--token-only`; `--telegram` and `--remove` stay.

## Three changes to the design

**Changed 1: the token is stored last, not first.** Until step 4 it is only in the server's memory, for at most 15 minutes. Cancel, a closed page, a failure or a restart then leave nothing behind, because nothing was stored. If the Keychain doesn't take it, the lead can try again without pasting it again. Price: it is in memory for minutes, not seconds. The terminal way stores it first, as now, because macOS's own command asks for it there.

**Changed 2: every setup gets a Keychain item of its own,** `konfab-telegram-token-` and a random id, instead of the two places `a` and `b`. It is added without "replace", so it is refused if it exists. Why:

- Nothing is ever replaced. "Ended in the middle of a replacement" and "an item that another program made" can't happen any more; they needn't be proven.
- **A fault of today goes away:** `a` and `b` are the same for every Konfab folder of a user. A second Konfab (another `KONFAB_HOME`) that sets up or removes phone notices replaces or deletes the first one's token. Found while reading the code for this plan; not tried.
- Only names that Konfab made and noted are ever deleted.

`telegram.json` gets `slot: "own"` and the item's name. Setups with `a`, `b` or `env` go on working and are only replaced by a new setup. **Going back to an earlier Konfab:** it doesn't know "own", shows phone notices as not set up and sends nothing. The setup is then made again. (SE9 says that going back works; this is the one exception, and the guide will say it.)

**Changed 3: no clean-up at a start.** It would have to read the Keychain, which can open a window nobody expects. A left-over is shown instead, with **Remove it**.

## The fallback is part of the plan

Step 1 always has two ways; step 2 to 4 are the same:

| Way                      | When                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paste here**           | macOS, if the trials below pass; Linux                                                                                                                                                 |
| **In the terminal**      | always on macOS and Linux: `npm run setup -- --telegram --token-only`. macOS (or, on Linux, Konfab) asks for the token without showing it; the page waits for it and goes on by itself |
| **From the environment** | `KONFAB_TELEGRAM_TOKEN` is set for the server; the only way on other systems; when it is set, a new setup uses it everywhere                                                           |

If a trial fails, **Paste here** isn't built, and everything else is. If storing fails on somebody's computer (locked, refused, a limit, an unknown result), step 4 says so, with **Try again** and **In the terminal**, and the earlier setup works on.

**Who owns a note.** Notes are in this Konfab folder only (`telegram-notes.json`, private), so another folder never sees them. The page's setup shows a command with a code of its own: `npm run setup -- --telegram --token-only <code>`. The note is made for that code. Only the setup with that code can claim it: in the lock, once, ready, less than 15 minutes old, and not claimed before. A second setup has another code. The code isn't a secret and proves nothing but which setup is meant.

| Note    | Meaning                                      | Can be claimed     |
| ------- | -------------------------------------------- | ------------------ |
| storing | the terminal is asking, or died while it did | no                 |
| ready   | read back; with the bot's number             | once, by its setup |
| claimed | by a setup that is under way                 | no                 |
| unknown | it isn't known whether something was stored  | no                 |
| unused  | left over, or replaced                       | **never again**    |

Cancel, the end of the setup's time, or a restart make a ready or claimed note a left-over: shown, with **Remove it**. Nothing is deleted by itself but the item of a setup that was just replaced or removed by the lead.

## On Linux: a private file instead of the Keychain

The lead chose this (B): the Keychain on macOS, and on Linux, which has no Keychain, a private file. Everything else is the same: the same item names, notes, claims, commit and deletion rules, because only the place where an item is kept differs.

- **Where:** `<Konfab folder>/tokens/<item>`, one file per setup. The folder is made `0700`, each file `0600`. Nothing else is in the folder, and Konfab never copies it (the settings' earlier copies are only of `config.yaml`).
- **Never replaced:** a file is made new (`O_CREAT|O_EXCL`), so one that exists is refused, as an item without "replace" is in the Keychain.
- **Nothing private is followed elsewhere:** the folder must be a real folder, not a link; a file is opened with `O_NOFOLLOW` and without waiting (`O_NONBLOCK`), so a pipe or socket put there can't hold up the server; it must then be a plain file. Both must belong to this user and be open to nobody else. Otherwise the answer is _unknown_, so nothing is used, stored or deleted.
- **Not there** is only a missing folder or file; every other failure is unknown, as with macOS's code 44.
- **The terminal asks** without showing what is typed (no system program does this on Linux). What isn't a token is refused before anything is written.
- **What it doesn't do:** the file is plain text on disk, and in backups of the home folder. Programs that run as the lead can read it, as they can ask macOS for the Keychain item. The guide says so.
- **Other systems** (Windows) have no place: the token comes from the environment, as before.

## The Keychain: what is known, and what isn't

| Question                                                                                                 | State                                                           | Needed for                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| `security -i` stores, reads back equal, prints nothing, isn't in the process list (11 looks)             | **seen** (2026-11-25, throwaway keychain)                       | Paste here                      |
| a wrong option: refused, the token not printed                                                           | **seen**                                                        | Paste here                      |
| a locked keychain waits with a window                                                                    | **seen**                                                        | the limit, the words            |
| K1 the window is refused: code, output, nothing stored                                                   | not known                                                       | Paste here                      |
| K2 ended by the limit while the window is open: does it stay, is something stored, can it be tried again | not known                                                       | Paste here                      |
| K3 the window is answered: stored, read back                                                             | not known                                                       | Paste here                      |
| K4 an item that exists, without "replace": refused, unchanged                                            | not known                                                       | Changed 2                       |
| K5 the token isn't in the process list or output in K1 to K4                                             | not known                                                       | Paste here                      |
| K6 reading a locked one later (a notice): window, limit                                                  | not known; today it can hold up the whole server for 10 seconds | all ways                        |
| K7 the login keychain in its usual state: no window at all                                               | as the terminal way today; not tried with `security -i`         | Paste here                      |
| other macOS versions                                                                                     | not known                                                       | said in the guide; the fallback |

**K1 to K7 are done only with the lead at the computer,** who says when. Each uses a made-up token. K1 to K6 use a throwaway keychain in a temporary folder that is deleted afterwards and never joins the search list. K7 is the only one that touches the login keychain: one item with a made-up value and its own name, deleted at once; it is done only if the lead agrees to it by itself. Before each the lead is told: what opens, what to press, what is expected. A script does one test at a time and stops after it. About 10 minutes.

**What decides:** K1 to K5 and K7 as expected: Paste here is built. Any other result: it isn't, and the result is written here. K6 only decides how reading is done (below).

**K4 can be done without a window** (an unlocked throwaway keychain, as in the first trial), but also waits for the lead, as agreed.

### Storing (Paste here)

1. The form is checked again (digits, a colon, letters, digits, `-`, `_`), and the name is ours; nothing needs quoting.
2. The note is written first: item, bot number, "unfinished".
3. `security -i` with the command in its input, no shell, its own small environment, no inherited files. Output is matched and dropped, never logged.
4. Limit 60 seconds, then it is ended. The page says before: "macOS may ask for your keychain password."
5. Whatever the result, the item is read once, with the same limit:

| Read                      | Then                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| equal to the token        | stored                                                                                                                           |
| surely not there          | not stored; nothing to clean up                                                                                                  |
| anything else, or unknown | **not committed, nothing deleted.** The note stays: "It isn't known whether a token was stored." **Try again** uses another name |

### Reading, for a notice

Today it is read in a way that the whole server waits for. Changed to one that doesn't, with the same 10 seconds, one at a time, and not again for 10 minutes after a limit; the page says "The stored bot token couldn't be read." This also concerns setups of today.

### Deleting

**The invariant:** a name enters `telegram.json` only by a commit, and a commit takes only a _claimed_ note of its own setup. A deletion first turns the note into _unused_ in the lock, where it also looks that `telegram.json` doesn't name it (or can't be read: then nothing is deleted). An unused note is never claimed or committed again, so an item can't come into use after that look, and deleting it outside the lock is safe. Names are random and never made twice.

**The places of before (`a`, `b`) are never deleted by Konfab itself,** since another Konfab folder may use the same one, which can't be found out. They are shown: "An earlier token may still be in your Keychain (konfab-telegram-token-a). Another Konfab folder of yours may use it." with its own button and question. This also goes for `--remove` in the terminal, which deleted both until now.

Only names from the notes, one at a time. **Only macOS's own "not found" counts as not there;** every other failure, a limit or a refused window is unknown. A result that isn't "deleted" or "wasn't there" keeps the note: "A token that isn't used may still be in your Keychain (its name)", with **Remove it**. **An item that the current setup names is never deleted,** except by **Remove**, which first takes the setup away.

## One setup at a time, and nothing undone

- **In the server's memory:** one setup, with a random number that each step must name. A second tab sees "A setup is under way" and can end it; the first one's next step is then refused.
- **Committing** happens in the settings' lock (phase 1): read `telegram.json`; if its setup number isn't the one this setup began with, refuse ("Phone notices were changed meanwhile"); else write. So a setup never brings back what was removed, and two setups (page and terminal) can't undo each other.
- **On, off, remove** use the same lock and read again inside it. Today on and off in the page read and write without one: a setup in the terminal that ends in between is undone by it. Fixed by this.
- **Right before the commit,** in the lock: that the setup wasn't cancelled and has time left (it can have waited for the lock), the setup number it began with, and that its note is still claimed by it. The setup ends in the same moment in which it is saved. So either it was ended first and nothing is saved, or it was saved first and there is nothing left to cancel; and it never ends a second one that began meanwhile. Claiming a note asks the same in the lock. The terminal's setup has no cancel but the end of its process, which also ends its waiting.
- **A notice being sent** uses one reading of `telegram.json` for chat, bot and place. After the token was read and before sending, it is read again: another setup number, or off, and nothing is sent.
- The Keychain is never called inside the lock.

| Interrupted                                                 | Then                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| before step 4                                               | nothing was stored; the earlier setup works                                                                                                  |
| between the note and storing                                | a note without an item; **Remove it** finds nothing and clears it                                                                            |
| the terminal dies after storing, before it noted the result | the note says _storing_; after 15 minutes it is a left-over: "may be in your Keychain". It is never taken as ready, and never read by itself |
| between storing and writing                                 | an unused item with its note                                                                                                                 |
| after writing, before the earlier token is deleted          | the new setup works; the earlier item has a note                                                                                             |
| during Remove                                               | off first; then as above                                                                                                                     |

## Routes

`GET /api/phone-notices` as now, with the setup's step, and never the token or the chat's number. `POST /api/phone-notices/setup` (way, and the token for Paste here), `…/code`, `…/test`, `…/finish`, `DELETE …/setup`, `POST /api/phone-notices/test`, `DELETE /api/phone-notices`.

- The lead's session **and** this page's own Origin, as in phase 1; an agent's token and a watcher's ticket are refused (tested for each).
- At most 1 KB. **A broken body isn't quoted anywhere:** the runtime's own error for broken JSON can contain a piece of it (seen for some forms), so this route's errors are answered and logged without their text.
- The token is in no answer, URL, log, stored reply, event, export, backup, note, error or environment of a started program. A test puts a marked token through every step and every failure, and searches all of these, the database and its files, and the page.
- Sending a test, asking Telegram and deleting have their own buttons; none is done by opening a page. At most 5 tokens an hour are checked.

## In the page

- The field: `type="password"`, no name, no suggestions, not kept in the page's state; read and emptied with the click, also on a failure. Pasting trims blanks.
- Waiting for the code shows the time left and can be read aloud once a minute, not every second. Each step's heading gets the focus. Cancel is always there.
- Keyboard, both themes, 375 px. The look was accepted with the mock-up of [Settings](settings.md).

## What isn't promised

That everything is cleaned up (what isn't known is shown, with its name); that a token is erased from memory (it is dropped; the runtime decides when its memory is used again); that an earlier Konfab works on with a new setup; that setting up is the same in the page everywhere (pasting depends on the trials, the terminal way on macOS, and on other systems the token comes from the environment).

## What it doesn't protect against

Other programs of the same user: the item can be read by whoever can run macOS's `security`, as today; the server's memory and the page's session too. The browser and its extensions while the token is typed. Telegram sees the bot, the chat and when notices are sent. The guide says this where the token is pasted.

## Order of work

| Part | What                                                                                                                                                                                         | Depends on                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A    | lock and setup number for on, off, remove and the terminal's commit; items of their own; notes; reading without holding up the server; `--status`, `--on`, `--off`, `--test`, `--token-only` | nothing (stand-ins only). Changed 2 relies on K4 |
| B    | the page with steps 2 to 4, **In the terminal** and **From the environment**; Send a test, Set up again, Remove                                                                              | A                                                |
| C    | K1 to K7, with the lead                                                                                                                                                                      | the lead's time                                  |
| D    | **Paste here**                                                                                                                                                                               | C passed                                         |

A and B are useful without D, and can be merged without it. The documents say for each what is there.

## Verification

**Automated, with stand-ins for Telegram and for `security` (never the real ones; the stand-in records arguments, input and environment):**

- Each step and way out: in the page, in the terminal, from the environment; cancel, close, 15 minutes, restart, kill at every point (each row of the tables above).
- Storing: every row of the reading table; a limit; output with odd text; a stand-in that hangs, dies, answers late, or stores and then fails.
- **The current setup's item is never deleted,** over all orders of: setup in the page, setup in the terminal, on, off, remove, remove a left-over, from two processes.
- Two Konfab folders of one user, side by side: neither touches the other's item.
- Setups of today (`a`, `b`, `env`) are read, used, tested, replaced and removed; an unknown `slot` sends nothing.
- A notice that is being sent while the setup is replaced or removed: to the old chat with the old bot, or not at all; never a mix.
- The server goes on answering while reading or storing hangs.
- The marked token, as above; broken bodies; too large ones; all routes against other identities.
- The page: the field, the steps, focus, a second tab, late answers (as in phase 1's draft tests).

**By hand, with the lead:** K1 to K7. Then the whole setup in both ways with a real bot, one real notice (away 1 minute), Set up again, Remove, and a look into Keychain Access that only the expected item is there.

## Questions for the lead

1. **Changed 2** means that after going back to an earlier Konfab, phone notices are set up again. All right? I recommend it.
2. **K1 to K7:** about 10 minutes together, with a few macOS windows. When? And may K7 put one made-up item into your login keychain for a moment?
3. **A and B first,** so that everything but pasting the token is in the page already? I recommend it.
