# Import a local skill

**Status:** proposed design for [REQUIREMENTS §19](../../REQUIREMENTS.md#19-import-a-local-skill) (LI1–LI6).

The lead picks a skill folder or a single `SKILL.md` anywhere on their Mac. Konfab previews it, lets the lead choose the name, and creates the matching folder in the chosen library. It reuses the code paths that copy public skills, so there is one way to add a skill's rows and write its folder.

## User flow

**⚙ Manage library** (My skills or Project) gets an **Import…** button with two choices: **Choose folder…** and **Choose SKILL.md…**.

The preview dialog shows:

- **Name.** Editable and checked live: the format rule and whether the name is free in this library. When it differs from the manifest, a line shows the change, e.g. `name: guide-architect → architect`.
- **Destination.** My skills, or the room's project library when it is available, plus the folder it will create (`~/.konfab/skills/<name>/`).
- **Description and licence** from the manifest. Below them, the `SKILL.md` text and the file list with sizes.
- **Not imported.** `.DS_Store` files and `.git/` folders, listed by path. A single-file import says "Only SKILL.md is imported; other files next to it are not included." It also warns about relative links in it that point to files it doesn't include (best effort, see below).
- **Errors.** Shown inline, using the same messages as **Save revision**. **Import** stays disabled until there are none.

The collision box appears only when the chosen name is taken in this library:

| Existing                                       | Box says                                                                                                                                                     | Actions                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Tracked skill, no unsaved edits                | "`architect` exists (rev 3, used by Room x · claude). **Replace** saves this as rev 4. Rev 3 stays in History, and agents stay on it until you update them." | **Use another name** (focuses Name), **Replace…** |
| Tracked skill with unsaved edits in its folder | "`architect` has unsaved edits. Save or discard them first, or use another name."                                                                            | **Use another name**                              |
| Trashed skill                                  | "`architect` is in Trash. Restore it first to replace it, or use another name."                                                                              | **Use another name**                              |
| Untracked folder                               | "A folder `architect` already exists but isn't a saved skill. Adopt or move it first, or use another name."                                                  | **Use another name**                              |

**Replace…** turns into a second, explicit **Replace architect** button. A built-in skill with the same name isn't a collision: built-ins are a separate, read-only library. The preview just notes "Also a built-in skill; agents see each by its library."

After **Import** (or **Replace**), the dialog closes and the skill opens in the editor at its new, unreviewed revision. No assignment changes.

## Getting the files from the browser

The page reads the chosen files with the browser's own picker. Konfab never receives a path on the Mac and never reads outside its libraries.

- **Folder:** `<input type="file" webkitdirectory>`. Each `File` has `webkitRelativePath` (`chosen-folder/sub/file.md`). The first segment is the chosen folder's name and is stripped. That name is kept as `source_name` for provenance.
- **Single file:** `<input type="file" accept=".md">`. The file must be named `SKILL.md` (case-sensitive), otherwise it is refused before upload.
- **Symbolic links.** The browser exposes only names and contents, not whether an entry was a link. In Chromium-based browsers and Safari a linked file is read through the link, and a linked folder may be followed or skipped. So Konfab can't detect links and doesn't claim to. The preview's file list is the safeguard: whatever arrives is shown before anything is saved. Nothing is written outside the library either way, because the server only receives contents. Before implementation I'll check what Chrome and Safari actually do on macOS and record the result in this note and in the user guide.
- **File modes** aren't exposed. Imported files are saved as 0644, so scripts lose their executable bit. Konfab never runs them anyway, and the user guide says so.
- **Limits** are checked in the page first, for fast feedback, and again on the server: 512 KiB per file, 2 MiB in total and fewer than 1,000 files, the same as `readSkillFiles`. Excluded files don't count.

## API

Both calls are page-only (cookie-authenticated), like the other library routes. They are stateless: confirm sends the same files again, and the server checks them against what the preview returned.

```
POST /api/library/import/preview      bodyLimit 4 MB
{ scope, room_id?, source_name, single_file, files: [{ path, content_base64 }], name? }
→ { name, manifest_name, description, licence, folder, files: [{path, size}], excluded: [path],
    missing_references: [path], rename: { from, to } | null, errors: [message],
    builtin_name: boolean,
    collision: null | { kind: "tracked", skill_id, number, revision_id, draft: boolean,
                        draft_hash, used_by: [label] }
                    | { kind: "trashed" | "untracked" },
    expected: { package_hash, collision_revision_id | null, collision_draft_hash | null } }

POST /api/library/import               bodyLimit 4 MB
{ ...same as preview, name, action: "create" | "replace", expected }
→ { skill_id, revision_id }
```

Errors on confirm:

- `import_changed` (409) when anything in `expected` no longer matches: the package hash, or the existing skill's revision or folder hash. The page re-runs the preview and shows "This changed since you previewed it; review again."
- `name_conflict` (409) when `create` meets any skill or folder with that name.
- `draft_conflict` (409) when `replace` finds unsaved edits.
- `unavailable` (404) when the project library is missing.
- `invalid_skill` (400) with the manifest or path message.

## Server

A new `SkillLibrary.prepareLocalImport(libraryId, upload, name?)` returns the preview. `importLocal(libraryId, upload, name, action, expected)` writes.

1. **Normalise.**
   - Decode the files and strip the folder prefix.
   - Drop `.DS_Store` (any depth) and anything under a `.git/` path segment, recording them as excluded.
   - Reject absolute paths, `..`, empty segments, backslashes and NUL. Also reject duplicate paths after normalisation (including two that differ only in case, because the Mac file system usually ignores case), a missing `SKILL.md`, and anything over the size limits.
2. **Rename.** Factor out the `name:` rewrite already in `importPublicForAssignment` into `renameManifest(files, name)`. It uses `yaml` `parseDocument`, so comments and other keys survive. Then validate with `skillMetadata`.
3. **Licence.** Read `license` from the front matter, a string of 200 characters or fewer, else null. Store it in `skill_revisions.licence`.
4. **Provenance.** `{"local_import": {"source_name": "<chosen folder or SKILL.md>", "imported_at": <ms>, "renamed_from": "<manifest name>" | absent}}`. A replacement records the same, so `sameSource` no longer matches a previous public source. A later public import of that skill then reports `local_changes` and asks Keep / Add as `-2` instead of updating silently.
5. **Missing references** (single file only, best effort). Scan Markdown links `](relative/path)` and backtick spans that look like relative paths with an extension (`` `scripts/run.sh` ``). Ignore URLs, anchors and absolute paths, and report the ones that are not in the package. It is a warning only.
6. **Collision check** in the chosen library. Read the `skills` row by `folder_name`, including trashed rows. If there is none, check whether a folder of that name exists on disk.
7. **Write**, in one `BEGIN IMMEDIATE` transaction after re-checking `expected`:
   - **create:** insert the skill and revision 1, and queue a `skill_workspace_operations` row.
   - **replace:** insert revision N+1, move `current_revision_id`, and queue a workspace operation with `previous_revision_id` = N.

   Both reuse `insertRevisionRows`. Nothing is marked reviewed and no assignment is touched. After the commit, `finishWorkspaces()` writes the folder through the existing journal: a staging folder with an owner marker, then a rename. For a replacement, the old folder is moved aside only if it still equals rev N. So an edit made after the check is never overwritten. The operation simply stays pending and shows in Manage library, as it does today.

`importPublicForAssignment`'s new-skill branch and `importLocal` share one private `addSkillRows(libraryId, files, metadata, provenance, licence)`, so the two importers can't drift apart.

## Failure and recovery

| When                               | Result                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancel, or close the dialog        | Nothing was written; the preview has no server state.                                                                                                                    |
| Validation or `expected` fails     | 4xx before the transaction; nothing written.                                                                                                                             |
| Crash inside the transaction       | SQLite rolls back; nothing written.                                                                                                                                      |
| Crash after commit, before folder  | The revision is saved and the folder is written by the journal on the next start (`recoverAssignedWorkspaces`), or by Manage library's existing retry.                   |
| Folder appeared meanwhile, or edit | The workspace operation stays pending and is never overwritten. Manage library shows the existing "working folder differs" state, and History has the imported revision. |

The source files are only read, by the browser. Existing revisions are never changed or deleted.

## Page

- `web/src/LocalImport.tsx`: the picker, the dialog and the preview. The preview is re-requested 300 ms after the name changes, and the in-flight request is cancelled.
- In `Library.tsx`, an **Import…** button next to **New skill**. On success it opens the imported skill.
- The dialog follows the existing dialog styles. Both themes are covered by the Playwright theme projects.

## Tests

- **Unit (`skill-library`):**
  - folder import with nested files;
  - single file, with the not-included notice and a missing-reference warning;
  - renaming with and without a collision (the manifest changes, comments are kept, the rest is byte-identical);
  - licence carried over;
  - `.DS_Store` and `.git` excluded;
  - unsafe, duplicate and case-duplicate paths, and the limits;
  - each collision kind;
  - a built-in name allowed;
  - replace: rev N+1 unreviewed, rev N restorable, assignments unchanged;
  - replacing a public copy makes a later public import report `local_changes`;
  - `import_changed` for a changed package, revision or folder;
  - `draft_conflict`.
- **Restart (integration):** commit an import, close before `finishWorkspaces`, then reopen with `createRuntime` + `buildApp`. The folder is written and the API lists the skill. A folder created in between is left alone and the operation stays pending.
- **API:** the routes, body limit, cookie auth and an unavailable project library.
- **Browser (Playwright, both themes):** import a folder with `setInputFiles` (directory), rename, hit a collision → Replace → History shows both revisions; import a single file; check that the stale-preview message appears after an outside edit.
- **Manual:** the symlink behaviour in Chrome and Safari, recorded here.

## Out of scope

Importing several skills at once, `.zip` archives, drag-and-drop (a later addition that can feed the same preview), and keeping file modes.
