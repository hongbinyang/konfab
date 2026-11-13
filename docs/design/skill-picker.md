# Skill picker

**Status:** built. Replaces the earlier role picker notes. Used by **Assign skills** on a member card and **Choose skills…** when adding an agent (`web/src/AssignSkills.tsx`).

## Finding skills

- One search covers **My skills**, **Project**, **Built-in** and **Public**. Filters are independent toggles: selecting **All** clears them, deselecting the last returns to All, and several selected categories combine as a union. Results are grouped by category; the previewed result has a distinct look and `aria-pressed`. Arrow keys move between visible results across groups.
- Each filter has a tooltip naming where it comes from, read from an authenticated API (`/api/rooms/:id/picker-locations`) rather than assuming the default home: the personal skills folder, the room's project folder (or how to set one, without creating it) and the enabled public sources. A path shows where a library is or would be, not that it exists.
- Public search streams: names appear first, descriptions fill in, and progress distinguishes listing, descriptions, done and errors from server state. Already found results stay visible while loading.
- **Preview** shows the `SKILL.md`, the file list with **View** for each supporting file, and for public skills the source, commit and licence. Nothing is saved while browsing or previewing.

## Choosing

- **Add** puts a skill in the ordered **Selected** list: ↑/↓, ✕, **Full text / Summary**, review state, and for a pin with a newer saved revision **Show changes** (a line diff of `SKILL.md`) and **Use rev N**.
- Room instructions and a size meter measured by the server; **Assign** is disabled above 64 KiB.
- Confirming reviews exactly the revisions shown. A public skill that clashes with the library shows a choice bound to that skill (not its list position): **Keep my version** (shows the exact saved revision for review; drafts excluded) or **Add as `name-2`**. While a choice is open, or its preview is loading or failed, the list is locked and confirming is disabled.

## Theme and accessibility

The dialog, backdrop, controls and selected rows use the page's theme tokens in light and dark, with visible focus. Tests: `tests/web/assign-skills.test.tsx`, `tests/web/add-agent-form.test.tsx`, `tests/e2e/agents.spec.ts`.
