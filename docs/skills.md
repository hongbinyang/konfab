# Skills: lifecycle guide

This guide walks through giving agents skills, from finding a skill to updating and retiring it. For setup and day-to-day room use, see the [user guide](user-guide.md).

## The idea in one minute

- A **skill** is a folder with a `SKILL.md` file, in the open [Agent Skills](https://agentskills.io/) format. It can describe a responsibility ("you are the reviewer…"), a procedure ("how to review a diff"), or both.
- An agent's **assignment** in a room is an ordered list of skills plus optional **room instructions**. The agent follows room rules and your instructions first, then its skills in order; when two skills conflict, the earlier one wins.
- An agent has two attributes: its **app** (the desktop app that runs it) and its **skills** in each room.

Three rules keep this predictable:

1. **Everything an agent uses is local and pinned.** Public skills are copied into your library when you assign them, and assignments point at an exact saved revision. Nothing changes under a running room unless you update it.
2. **You review before agents use it.** Confirming an assignment reviews exactly the revisions shown.
3. **Skills are instructions, not permissions.** They never grant file, network or push access, and Konfab never runs their scripts.

## Where things live

| What                                     | Where                                                  |
| ---------------------------------------- | ------------------------------------------------------ |
| Your personal skills                     | `~/.konfab/skills/<name>/SKILL.md`                     |
| Project skills (shared through the repo) | `<project folder>/.konfab/skills/<name>/SKILL.md`      |
| Built-in skills (pm, implementer, …)     | Shipped with Konfab, read-only                         |
| Saved revisions, reviews and assignments | `~/.konfab/konfab.db`                                  |
| Public skills                            | Searched live on GitHub; only skills you use are saved |

The folders are ordinary files you can open in any editor. Each **Save revision** also stores an immutable snapshot in the database, so history survives outside edits.

## The lifecycle

```
Find ──► Assign ──► Edit and save ──► Update members ──► Retire
```

### 1. Find and assign

On an agent's card, select **Assign skills**. One search covers **My skills**, **Project**, **Built-in** and **Public** (GitHub sources enabled in **⚙ Manage library → Public**). Select a result to preview its instructions, files, licence and source; nothing is saved while you search or preview.

**Add** puts a skill in the **Selected** list. Reorder with ↑/↓, remove with ✕, and choose per skill:

- **Full text:** the whole `SKILL.md` is sent to the agent.
- **Summary:** only its name and description; the agent reads the text with `read_skill_file` when it needs it.

Add **room instructions** if this agent needs something only in this room. An agent can receive up to 64 KiB; the size meter shows the total, and **Assign** is blocked above the limit until you switch a skill to Summary, remove one, or move long material out of `SKILL.md` into supporting files.

**Assign** saves the list. Any revision not yet reviewed is marked reviewed by this confirmation. The agent gets the new assignment on its **next turn**, with a short notice of what changed.

### 2. Public skills

Assigning a public skill copies only that skill's files into your library, verified against the source commit, with its source, commit and licence recorded. Adding it again later:

- **same commit:** reuses your copy;
- **newer commit, your copy unchanged:** adds a new revision to your copy;
- **newer commit, your copy edited** (or a different skill has that name): Konfab asks — **Keep my version**, or **Add as `name-2`**. It never overwrites your changes. Keeping your version shows that exact saved revision for you to review before you confirm; unsaved changes in its folder are not included.

If the assignment fails (for example someone changed it meanwhile), nothing it would have copied is kept. The same applies when adding an agent with skills: no agent is created until the choice is made.

### 3. Edit

Edit `SKILL.md` and its files in **⚙ Manage library**, or choose **Copy path** next to the working folder and use your own editor. Changes made outside Konfab appear as a **Draft** until you save. **Save revision** checks the format and stores rev 1, rev 2, and so on. **History** lets you view any revision or restore it as a new one. If someone else saved in between, Konfab shows a conflict instead of overwriting.

Built-in skills are read-only: **Duplicate** one to make an editable copy in your library.

### 4. Update members

Saving a new revision changes no assignment. To move agents to it:

- **One agent:** its card shows **Update available**. Open **Assign skills**, select **Show changes** to see the difference, then **Use rev N** and **Assign**.
- **Several agents, across rooms:** open the skill in **⚙ Manage library**. **Used by** lists every room and member and the revision each uses. Tick the members to move and select **Review and update**. Archived rooms are not updated; everyone you didn't tick stays pinned.

### 5. Move skills between agents

Select **Team** in the room header. Drag a member's skills onto another member (or use **Swap with**) to swap; repeat to rotate; or remove a member's skills. Skills move with their room instructions; names, apps and **May edit files** stay with each member. Changes apply in one step from each agent's next turn, and a short system message asks agents to hand over open work.

### 6. Retire

**Move to Trash** removes a skill from lists. It's blocked while an agent uses it, and Konfab names who does, for example "Skill in use: Room konfab-improvement · claude". Remove it from those assignments first. **Restore** brings it back from Trash. Saved revisions stay in the database.

## Upgrading from roles

Earlier versions had roles. On the first start of this version, Konfab:

- writes a backup to `~/.konfab/backups/konfab-pre-skills-…db`;
- turns each role in use into a personal skill with the same text (adding `-role` to the name if it is taken) and gives it to the same agents, with the role's pinned skills after it as summaries;
- turns free-text roles and room notes into room instructions;
- leaves `~/.konfab/roles` untouched (you can delete it).

`npm run upgrade-check` shows the result on a copy without changing anything. If an assignment would not fit in 64 KiB even as summaries, the upgrade stops before changing anything and says which room and agent to adjust. Agents connected before the upgrade are designed to keep working in their current conversations: automated tests replay the previous bridge against the upgraded server, but this hasn't yet been confirmed with the desktop apps. If an agent doesn't continue, use **Take a break**, reload the Konfab connector in its app, and paste a fresh join prompt. Reloading the connector also adds the `read_assignment` tool.

## Quick reference

| I want to…              | Do this                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| Give an agent skills    | Agent card → **Assign skills** → search → **Add** → order → **Assign**       |
| Use a public skill      | **Assign skills** → **Public** → preview → **Add to selection** → **Assign** |
| Change a built-in skill | ⚙ Manage library → **Built-in** → open it → **Duplicate**, then edit         |
| Roll out a skill edit   | Save revision → open the skill → **Used by** → tick → **Review and update**  |
| Swap or rotate skills   | Room header → **Team** → drag or **Swap with** → **Apply**                   |
| Undo an edit            | History → **Restore** (creates a new revision)                               |
| Stop using a skill      | Remove it from assignments → **Move to Trash**                               |

## Troubleshooting

| Message                                       | Meaning and fix                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "These skills total … KiB"                    | The assignment is too large to send. Switch a skill to **Summary** or remove one.                                         |
| "… has local changes"                         | Your copy of a public skill was edited. Choose **Keep my version** or **Add as `name-2`**.                                |
| "Skill in use: …"                             | An agent still uses it. Remove it from those assignments first.                                                           |
| "This assignment changed since you opened it" | Someone changed it meanwhile. Reopen **Assign skills** and try again.                                                     |
| "GitHub limit reached; resets at …"           | GitHub allows 60 requests an hour without a token. Wait, or add a [GitHub token](user-guide.md#15-github-token-optional). |
| "Project folder unavailable"                  | The room's project folder moved or is missing. Set it again under the room's **Edit**.                                    |
