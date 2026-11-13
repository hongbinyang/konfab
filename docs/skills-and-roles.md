# Skills and roles: lifecycle guide

This guide walks through giving an agent a role built from reusable skills, from finding a skill to retiring it. For setup and day-to-day room use, see the [user guide](user-guide.md).

## The idea in one minute

- A **skill** is a reusable workflow, such as "review a diff" or "test a web app". It is a folder with a `SKILL.md` file, in the open [Agent Skills](https://agentskills.io/) format.
- A **role** is an ongoing responsibility, such as Reviewer or Product manager. It is a folder with a `ROLE.md` file, plus a list of skills it uses.
- You **assign** a role to an agent in a room, optionally with **room notes** that apply only there.

Three rules keep this predictable:

1. **Everything an agent uses is local and pinned.** Public skills are copied into your library before use, and assignments point at an exact saved revision. Nothing changes under a running room unless you update it.
2. **You review before agents use it.** A role can only be assigned when every skill it pins has a reviewed revision.
3. **Roles and skills are instructions, not permissions.** They never grant file, network or push access, and Konfab never runs their scripts.

## Where things live

| What                                           | Where                                                  |
| ---------------------------------------------- | ------------------------------------------------------ |
| Your personal skills                           | `~/.konfab/skills/<name>/SKILL.md`                     |
| Project skills (shared through the repo)       | `<project folder>/.konfab/skills/<name>/SKILL.md`      |
| Your personal roles                            | `~/.konfab/roles/<name>/ROLE.md`                       |
| Built-in roles (PM, Implementer, Reviewer, QA) | Shipped with Konfab, read-only                         |
| Saved revisions, reviews and assignments       | `~/.konfab/konfab.db`                                  |
| Public skills                                  | Searched live on GitHub; only skills you use are saved |

The folders are ordinary files you can open in any editor. Each **Save revision** also stores an immutable snapshot in the database, so history survives outside edits.

## The lifecycle

```
Find ──► Review & assign (or Customize) ──► Update ──► Retire
```

Most of the time you only need **Change role** on an agent's card: find a skill or role, check the preview, and assign it. Sections 3–5 describe the optional manual path in **⚙ Manage library** for building your own skills and roles.

### 1. Find a skill or role

On an agent's card, select **Change role**. One search covers:

- **My roles**, **My skills** and **Project** skills already in your library.
- **Public** skills from GitHub (Anthropic and OpenAI by default; enable more in **⚙ Manage library → Public**). Names appear immediately and descriptions fill in over a few seconds. Nothing is saved while you search or preview.

Select a result to preview it: what it does, its files, licence, and the exact source commit. Every public result shows whether its source is Vendor-maintained or Community.

### 2. Assign it, or customize first

- **Review & assign to _agent_** approves the exact revision you previewed and assigns it in one step. For a public skill, only that skill's files are copied into your library, verified against the source commit, with its source, commit and licence recorded. Konfab creates a role around it for you.
- **Customize** opens an editable copy (role name, instructions, skill) in the same window. Choose **Save and assign** when done; the copy goes to **Mine** by default, or **This project**.

The agent receives its new role on its **next turn**, with a short notice that its role changed.

To build skills from scratch or adopt folders already on disk (shown as **Untracked**), use **⚙ Manage library → Mine** or **Project**.

### 3. Edit (optional)

Edit `SKILL.md` and its files in Konfab, or choose **Copy path** next to the working folder and use your own editor. Changes made outside Konfab appear as a **Draft** until you save.

**Save revision** checks the format and stores rev 1, rev 2, and so on. **History** lets you view any revision or restore it as a new one. If someone else saved in between, Konfab shows a conflict instead of overwriting.

### 4. Review

Read the skill, then choose **Mark saved revision reviewed**. A review covers that exact revision only: any later edit creates a new revision that starts as **Not reviewed**.

Adding or previewing a skill never marks it as reviewed.

### 5. Build a role

Open **⚙ Manage library → Roles**.

- The four **built-in** roles are read-only. Choose **Duplicate role** to make an editable copy, titled "… (copy)".
- Edit the copy's `ROLE.md` (responsibilities) and choose **Add skill** to pin skills. Each pin is the skill's current saved revision at that moment.
- **Save revision** stores the role. You can save a role that pins unreviewed skills while you work on it; you just can't assign it yet.

### 6. Assign it

To assign a role you built manually, choose **Edit role** on an agent's card (or **Change role**, which also lists your roles):

1. Pick a role. Built-in and personal roles are labelled.
2. Optionally add **room notes**, such as "Work only in your own worktree", which apply only in this room.
3. Check the **preview** of exactly what the agent will receive, then choose **Assign role**.

If a pinned skill isn't reviewed yet, Konfab names it and blocks the assignment until you review it.

The agent receives the full role on its **next turn**, and a short reminder on later turns. It can re-read the role or fetch a skill's files when it needs them. The card shows the role and revision, for example "Codex · Reviewer rev 1".

### 7. Update

Nothing updates automatically:

- **A skill changed:** saving it creates a new revision, but roles keep pinning the old one. To move a role forward, open the role, remove that skill's pin, **Add skill** again (it pins the current revision), and **Save revision**. Review the new skill revision first, or assignment will be blocked.
- **A role changed:** saving it creates a new role revision, but rooms keep the one they were assigned. To move a room forward, open **Edit role** on the agent card and assign the role again.
- **A public skill changed upstream:** the role shows **Update available** (or **Removed from source**). Your copy stays exactly as it is; to take the new version, find it again in **Change role** and assign it.

The agent gets the new role on its next turn.

### 8. Retire

**Move to Trash** removes a skill or role from lists. It's blocked while something still uses it, and Konfab names what does: for example, "Skill in use: Role Reviewer (copy) rev 2". Unassign or update those first. **Restore** brings it back from Trash. Saved revisions stay in the database.

## Converting existing free-text roles

If agents still have free-text roles typed into **Edit role**, choose **Convert all custom roles** in **⚙ Manage library → Roles** (or **Save as role pack** on a single agent card):

1. Konfab lists every member with free-text roles, grouped by identical text.
2. Tick the groups to convert and adjust names if needed.
3. Each group becomes one personal role (your text unchanged), optionally assigned to those members straight away.

Members already on a role pack are left alone. A converted member can be **reverted** to its original text.

## Quick reference

| I want to…            | Do this                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| Use a public skill    | Agent card → **Change role** → search → preview → **Review & assign**                |
| Change a public skill | **Change role** → search → **Customize** → **Save and assign**                       |
| Make my own role      | ⚙ Manage library → Roles → built-in → **Duplicate role** → edit → Save revision      |
| Swap or rotate roles  | Room header → **Roles** → drag roles between members → **Apply**                     |
| Give an agent a role  | Agent card → **Change role** → **My roles** → pick → **Assign**                      |
| Roll out a skill edit | Save + review skill → role: remove pin, **Add skill**, save → **Edit role** → assign |
| Undo an edit          | History → **Restore** (creates a new revision)                                       |
| Stop using something  | Unassign or update its users → **Move to Trash**                                     |

## Troubleshooting

| Message                               | Meaning and fix                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Review before assignment: …"         | A pinned skill revision isn't reviewed. Review it, then assign again.                                                     |
| "Skill in use: …" / "Role in use: …"  | Something still pins it. Update or unassign those first.                                                                  |
| "GitHub limit reached; resets at …"   | GitHub allows 60 requests an hour without a token. Wait, or add a [GitHub token](user-guide.md#15-github-token-optional). |
| A public skill shows a format problem | It breaks the skill format. Use **Customize**, fix it, then **Save and assign**.                                          |
| Conflict when saving                  | Someone saved first. Reload to see their version, then reapply your change.                                               |
| "Project folder unavailable"          | The room's project folder moved or is missing. Set it again under the room's **Edit**.                                    |
