# Import a local skill

**Status:** implemented on `feature/local-skill-import` (see "Implementation notes" at the end); design for [REQUIREMENTS §19](../../REQUIREMENTS.md#19-import-a-local-skill) (LI1–LI6), as of requirements commit cba73e9.

The lead picks a skill folder or a single skill file (any name, e.g. `architect.md`) anywhere on their Mac. Konfab previews it, lets the lead choose the name, and creates the matching folder in the chosen library. It reuses the code paths that copy public skills, so there is one way to add a skill's rows and write its folder.

## User flow

Clickable mockup: [mockups/local-import.html](mockups/local-import.html).

**⚙ Manage library** (My skills or Project) gets an **Import…** button with two choices: **Choose folder…** and **Choose file…**.

**File and folder names are sorted out by Konfab** (lead, msg 1073). The skill file can have any name. The skill's `name:` (or the name the lead types) becomes the folder, and the manifest is always saved as `SKILL.md`. The chosen folder's own name never matters. The preview shows each change, e.g. `architect.md → SKILL.md` and `guide-robotics-architect/ → robotics-architect/`.

The preview dialog shows:

- **Skill file.** The chosen source file and its destination, e.g. `architect.md → SKILL.md`. For a folder this is a picker (see below).
- **Name.** Editable and checked live: the format rule and whether the name is free in this library. When it differs from the manifest, a line shows the change, e.g. `name: guide-architect → architect`.
- **Destination.** My skills, or the room's project library when it is available, plus the folder it will create (`~/.konfab/skills/<name>/`).
- **Description and licence** from the manifest. Below them, the `SKILL.md` text and the file list with sizes.
- **Not imported.** `.DS_Store` files and `.git/` folders, listed by path. A single-file import says "Only this file is imported, as SKILL.md; other files next to it are not included." It also warns about relative links in it that point to files it doesn't include (best effort, see below).
- **Errors.** Shown inline, using the same messages as **Save revision**. **Import** stays disabled until there are none.

The collision box appears only when the chosen name is taken in this library:

| Existing                                       | Box says                                                                                                                                                     | Actions                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Tracked skill, no unsaved edits                | "`architect` exists (rev 3, used by Room x · claude). **Replace** saves this as rev 4. Rev 3 stays in History, and agents stay on it until you update them." | **Use another name** (focuses Name), **Replace…** |
| Tracked skill with unsaved edits in its folder | "`architect` has unsaved edits. Save or discard them first, or use another name."                                                                            | **Use another name**                              |
| Trashed skill                                  | "`architect` is in Trash. Restore it first to replace it, or use another name."                                                                              | **Use another name**                              |
| Untracked folder                               | "A folder `architect` already exists but isn't a saved skill. Adopt or move it first, or use another name."                                                  | **Use another name**                              |

**Replace…** turns into a second, explicit **Replace architect** button. A built-in skill with the same name isn't a collision: built-ins are a separate, read-only library. The preview just notes "Also a built-in skill; agents see each by its library."

After **Import** (or **Replace**), the outcome is one of two states, and the dialog says which (see "Saved versus ready" below):

- **Ready:** the revision is saved and its folder is written. The dialog closes, and the skill opens in the editor at its new, unreviewed revision.
- **Saved, folder pending:** the revision is saved and safe in History, but its folder couldn't be written yet. The dialog stays open and doesn't say "Imported". It says why the folder is pending and offers **Retry** and **Close**.

No assignment changes in either case.

## Getting the files from the browser

The page reads the chosen files with the browser's own picker. Konfab never receives a path on the Mac and never reads outside its libraries.

- **Folder:** `<input type="file" webkitdirectory>`. Each `File` has `webkitRelativePath` (`chosen-folder/sub/file.md`). The first segment is the chosen folder's name and is stripped. That name is kept as `source_name` for provenance.
- **Single file:** `<input type="file">` with no type filter. Any file name and extension is accepted. Its contents are validated (front matter with `name:` and `description:`, UTF-8 text, size), and it is saved as `SKILL.md`.
- **Which file is the skill file in a folder.** Konfab never guesses silently.
  1. If the folder has `SKILL.md` at its top level (exact name), it is used, and the preview shows "Skill file: SKILL.md".
  2. Otherwise the preview shows a **Skill file** picker that lists every included file (any name, extension or depth), and **Import** stays disabled until one is chosen. Files whose contents parse as a skill (front matter with `name:` and `description:`) are listed first and marked "looks like a skill file". If exactly one file does, it is preselected and the preview names it: "Skill file: architect.md, the only file with skill front matter. Change it if this is wrong." With several, none is preselected.
  3. The chosen file is moved to the top level as `SKILL.md`. Every other file keeps its path. If the chosen file was in a subfolder, or other files link to its old name, the preview warns about the links that may break, by path; links aren't rewritten.
  4. **Destination clash.** If another included file would end up at `SKILL.md` in any case (e.g. a top-level `skill.md` or `Skill.md` that wasn't chosen; the Mac file system usually ignores case), the preview explains it and blocks **Import**. The lead resolves it by choosing that file as the skill file instead, or by ticking **Leave this file out**. Nothing is overwritten or renamed silently.
  5. If no file is valid when chosen: "This file isn't a skill: add front matter with name: and description:."

- **Symbolic links: measured, not assumed.** The browser gives the page names and contents only; it doesn't say whether an entry was a link.
  - **Chromium, measured on macOS (2026-11-16).** A probe used the Chromium bundled with this repo's Playwright, with `webkitdirectory` and the folder handed to the browser to enumerate. The folder held `SKILL.md`, `sub/a.md`, a link to a file outside, a link to a folder outside and a broken link. The page received only `SKILL.md` and `sub/a.md`. All three links were **left out silently**, with no error.
  - **Not yet measured:** Safari and Firefox (their Playwright builds aren't installed here), and Chrome's native file dialog, which Playwright bypasses. I'll check Chrome and Safari with a small probe page and a prepared folder before the page change is merged, and record the results here and in the user guide. That check needs someone at the native dialog, so the lead or me with the lead's help.
  - **Consequence for the design:** the preview never implies the package is complete. A folder import always shows "Your browser may leave out linked files and folders without telling Konfab. Check that this list has everything you expect." above the file list, with a count. Nothing can be written outside the library either way, because the server only receives contents.
- **File modes** aren't exposed. Imported files are saved as 0644, so scripts lose their executable bit. Konfab never runs them anyway, and the user guide says so.
- **Limits** are checked in the page first, for fast feedback, and again on the server: 512 KiB per file, 2 MiB in total and fewer than 1,000 files, the same as `readSkillFiles`. Excluded files don't count.

## API

Both calls are page-only (cookie-authenticated), like the other library routes. They are stateless: confirm sends the same files again, and the server checks them against what the preview returned.

```
POST /api/library/import/preview      bodyLimit 4 MB
{ scope, room_id?, source_name, single_file, files: [{ path, content_base64 }], skill_file?, leave_out?: [path], name? }
→ { skill_file: path | null, skill_file_candidates: [path], destination_clash: path | null,
    broken_links: [path], name, manifest_name, description, licence, folder, files: [{path, size}], excluded: [path],
    missing_references: [path], rename: { from, to } | null, errors: [message],
    builtin_name: boolean,
    collision: null | { kind: "tracked", skill_id, number, revision_id, draft: boolean,
                        draft_hash, used_by: [label] }
                    | { kind: "trashed" | "untracked" },
    expected: { package_hash, collision_revision_id | null, collision_draft_hash | null } }

POST /api/library/import               bodyLimit 4 MB
{ ...same as preview, name, action: "create" | "replace", expected }
→ { skill_id, revision_id, number, folder: "ready" | "pending", pending_reason?: { code, folder, detail } }

POST /api/library/skills/:id/workspace/resolve
{ action: "retry" | "move_other_aside" | "save_edits" | "keep_edits_aside", expected_reason }
→ same { folder, pending_reason? }
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
   - Reject absolute paths, `..`, empty segments, backslashes and NUL. Also reject duplicate paths after normalisation (including two that differ only in case, because the Mac file system usually ignores case), and anything over the size limits. The skill file is chosen as described above and moved to `SKILL.md`. Leave-out paths are removed and recorded as excluded. A remaining case-insensitive clash with `SKILL.md` is a `destination_clash` error.
2. **Rename.** Factor out the `name:` rewrite already in `importPublicForAssignment` into `renameManifest(files, name)`. It uses `yaml` `parseDocument`, so comments and other keys survive. Then validate with `skillMetadata`.
3. **Licence.** Read `license` from the front matter, a string of 200 characters or fewer, else null. Store it in `skill_revisions.licence`.
4. **Provenance.** `{"local_import": {"source_name": "<chosen folder or file name>", "skill_file": "<original path of the skill file>", "imported_at": <ms>, "renamed_from": "<manifest name>" | absent}}`. A replacement records the same, so `sameSource` no longer matches a previous public source. A later public import of that skill then reports `local_changes` and asks Keep / Add as `-2` instead of updating silently.
5. **Missing references** (single file only, best effort). Scan Markdown links `](relative/path)` and backtick spans that look like relative paths with an extension (`` `scripts/run.sh` ``). Ignore URLs, anchors and absolute paths, and report the ones that are not in the package. It is a warning only.
6. **Collision check** in the chosen library. Read the `skills` row by `folder_name`, including trashed rows. If there is none, check whether a folder of that name exists on disk.
7. **Write**, in one `BEGIN IMMEDIATE` transaction after re-checking `expected`:
   - **create:** insert the skill and revision 1, and queue a `skill_workspace_operations` row.
   - **replace:** insert revision N+1, move `current_revision_id`, and queue a workspace operation with `previous_revision_id` = N.

   Both reuse `insertRevisionRows`. Nothing is marked reviewed and no assignment is touched. After the commit, `finishWorkspaces()` writes the folder through the journal, with the create-only steps in "Writing a folder without ever replacing one" below. Those steps replace today's staging-and-rename for every journal write, public updates included.

`importPublicForAssignment`'s new-skill branch and `importLocal` share one private `addSkillRows(libraryId, files, metadata, provenance, licence)`, so the two importers can't drift apart.

## Failure and recovery

| When                               | Result                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancel, or close the dialog        | Nothing was written; the preview has no server state.                                                                                                  |
| Validation or `expected` fails     | 4xx before the transaction; nothing written.                                                                                                           |
| Crash inside the transaction       | SQLite rolls back; nothing written.                                                                                                                    |
| Crash after commit, before folder  | The revision is saved and the folder is written by the journal on the next start (`recoverAssignedWorkspaces`), or by Manage library's existing retry. |
| Folder write fails (disk, access)  | Saved, folder pending: the dialog shows the reason and **Retry**; the library row keeps the pending notice until a retry succeeds.                     |
| Folder appeared meanwhile, or edit | Saved, folder pending; nothing is overwritten. The reason names the conflicting folder, or says the existing folder was edited after the check.        |

The source files are only read, by the browser. Existing revisions are never changed or deleted.

### Saved versus ready

An import has one commit point: the transaction that adds the revision. Before it, a failure leaves nothing behind. After it, the revision exists and is never rolled back. The folder is a working copy of that revision, written afterwards through the journal. So there is never a partial _skill_, only a saved revision whose folder may still be pending.

- **The response tells the truth.** `importLocal` runs `finishWorkspaces()` for that skill straight after the commit, then reads its `skill_workspace_operations.state`. The route returns `folder: "ready"` only when the state is `complete` and the folder's package hash equals the revision. Otherwise it returns `folder: "pending"` with a `pending_reason`:
  - "A folder named X appeared before Konfab could write it."
  - "X was edited after the check, so Konfab didn't replace it."
  - "Couldn't write to the library folder: <error code>."
- **The page never reports completion early.** On `pending` it shows "Saved as rev N, but its folder isn't written yet", the reason, and the actions for that reason (table below). The library row shows the same, replacing today's generic "could not be created … restart to retry" notice. That also helps public imports, which use the same journal.
- **The reason is a code**, so the page can offer real fixes. `pending` carries `pending_reason: { code, folder, detail }`. Retry alone is offered only where waiting or fixing access can help.

| `code`                             | Cause                                                      | Actions (each one explicit, nothing deleted)                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder_exists`                    | An untracked folder with this name appeared before writing | **Move the other folder aside**: Konfab moves it into a kept folder (`.konfab-previous/<random>/`, listed under Kept copies) and writes the import. Or **Rename this skill** (the existing rename) to write it under another name. Or **Move to Trash** to drop the import, offered only for a newly created skill. |
| `folder_edited`                    | Replace: the existing folder was edited after the check    | **Save my edits first**: saves the folder as a new revision on top. The import stays in History and the folder is then current, so the operation completes. Or **Use the import, keep my edits aside**: Konfab moves the edited folder into a kept folder (listed with **Show differences**) and writes the import. |
| `write_failed`                     | Disk full, permissions, library folder missing             | Shows the error code and the folder path (**Copy path**). **Retry** after fixing it; Konfab also retries at every start.                                                                                                                                                                                            |
| `edits_kept` (notice, not pending) | A kept previous folder differs from rev N                  | The notice names the kept folder and offers **Open**, **Show differences** and **Remove**. Nothing is pending and nothing is moved automatically.                                                                                                                                                                   |

All actions go through one route, `POST /api/library/skills/:id/workspace/resolve { action, expected_reason }`, with `retry` for **Retry**. It re-checks that the reason is unchanged (409 `import_changed` otherwise), performs the action and re-runs the folder write.

### Writing a folder without ever replacing one

**Rule:** at a path the lead can see (`<library>/<name>`), Konfab only ever **creates** things: a directory with an exclusive `mkdir`, which fails with `EEXIST`, and files with an exclusive open (`wx`, `O_CREAT|O_EXCL`). It never renames onto those paths. Renames happen only into private holding folders that Konfab creates exclusively with mode 0700 and a random name. So no existing directory, file or link, empty or not, and none of its metadata, is ever replaced.

The steps, recorded in `skill_workspace_operations` (new columns `step`, `claim_dev`, `claim_ino`, `kept_path`):

1. **check** (replace only). Check that `<name>` still equals rev N; if not, stop with `folder_edited`, untouched.
2. **move aside** (replace only). Create `.konfab-previous/<random>/` exclusively (0700), then rename `<name>` into it as `.konfab-previous/<random>/<name>`. The target is inside a folder Konfab just created, so there is nothing there to replace. The kept copy keeps its inode (see "Kept copies"). Record `kept_path`.
3. **claim.** `mkdir <name>`, non-recursive and exclusive. `EEXIST` → `folder_exists`, with nothing touched. Record its `dev`/`ino`, then create the marker `<name>/.konfab-writing` (`wx`) containing the operation id.
4. **write.** For each file of the revision: check that `lstat(<name>)` still has the claimed `dev`/`ino`. Then create any missing subdirectories with exclusive `mkdir`, where an existing one counts only if it was created in this operation (recorded), and create the file with `wx`. An existing file is never opened for writing.
5. **verify.** The `dev`/`ino` is unchanged, and the folder's package hash (without the marker) equals the revision. Then remove the marker and mark the operation complete.

A new skill runs steps 3–5. During steps 3–5 the folder is visibly partial: Manage library shows "Being written" on that skill, the marker explains it, and agents are unaffected because they read revisions from the database.

**Restart and retry** (`recoverAssignedWorkspaces`, and **Retry**) resume from the recorded step:

| Recorded step | What is found at `<name>`                                                 | Recovery                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| check         | Equal to rev N                                                            | Run from step 2.                                                                                                                                                  |
| move aside    | Absent, and the kept copy is at `kept_path`                               | Run from step 3.                                                                                                                                                  |
| move aside    | Still there, and `.konfab-previous/<random>/` is empty or absent          | The rename never happened: run step 2 again.                                                                                                                      |
| claim / write | Our claim: the marker holds this operation id and `dev`/`ino` match       | Continue step 4. Files already present must match the revision's bytes. If one differs, someone edited the partial copy: `folder_edited`, and nothing is removed. |
| claim / write | Absent (our partial claim was deleted)                                    | Run from step 3 again.                                                                                                                                            |
| claim / write | Something else: no marker, a different marker, or a different `dev`/`ino` | `folder_exists`; nothing touched.                                                                                                                                 |
| verify        | Our claim, complete                                                       | Remove the marker; done.                                                                                                                                          |

**Practical limits** (also in the user guide):

- Between the `dev`/`ino` check and a file create in step 4, another process running as the lead could delete Konfab's claim and put its own directory at that path. Konfab would then add a new file to that directory. It still can't overwrite or replace anything there (`wx`). The verify step sees the different inode, stops with `folder_exists` and lists the files Konfab created, so the lead can remove them. Node has no `openat`, so the files can't be pinned to the claimed directory's descriptor. This is the remaining window, and it adds files without replacing any.
- An editor that saves by path into the folder while it is being written makes step 4 or 5 find a differing file: `folder_edited`, nothing removed.
- Files are written one by one, so a crash leaves a partial, marked folder until the next start or **Retry** finishes it. Nothing is ever half-replaced.

**Kept copies are never deleted automatically.** A kept copy stays in `.konfab-previous` until the lead removes it. Konfab can't prove that no open handle will write to it later. Manage library lists kept copies per skill, with the size, **Open**, **Show differences** (against rev N) and **Remove** (asks for confirmation and names the folder). A copy whose hash differs from rev N is labelled "Edited after Konfab replaced it". No automatic action follows. While kept copies exist, a one-line notice shows their count and size.

**Putting a kept copy back** (offered when the import is pending and the lead wants the old folder visible again) copies it with the same create-only steps 3–5 into `<name>` (or `<name>-previous-<n>` if the name is taken). It never renames it back.

- **Agents are unaffected:** they read revisions from the database, not the folder, and assignments are pinned anyway.

## Page

- `web/src/LocalImport.tsx`: the picker, the dialog and the preview. The preview is re-requested 300 ms after the name changes, and the in-flight request is cancelled.
- In `Library.tsx`, an **Import…** button next to **New skill**. On success it opens the imported skill.
- The dialog follows the existing dialog styles. Both themes are covered by the Playwright theme projects.

## Tests

- **Unit (`skill-library`):**
  - folder import with nested files;
  - single file, with the not-included notice and a missing-reference warning;
  - any file name: `architect.md` alone, and a folder `guide-x/` holding `architect.md` + `notes/a.md` → folder `<name>/` with `SKILL.md`; several candidates → `manifest_candidates` and the chosen one used; none → the actionable error; `skill.md` → `SKILL.md`;
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
- **Never replaced:** using test hooks at each gap:
  - after step 1, put a non-empty folder, an empty folder, a file or a symbolic link at `<name>`;
  - between steps 3 and 4, replace the claim with another directory, empty or not;
  - during step 4, create one of the revision's files first.

  Each ends `folder_exists` or `folder_edited`. In every case, assert that the other directory or file is byte-identical, keeps its inode, mode and extended attributes, and that Konfab overwrote nothing. For the documented window (the claim swapped between the inode check and a file create), assert that Konfab only added new files and that verify reports them.

- **Kept copies:** open a file in the old folder before step 2 and write through the handle after step 5. The kept copy is never deleted, whatever the clock says, and is listed as "Edited after Konfab replaced it". **Remove** deletes it only after confirmation. An unchanged kept copy also stays until removed. **Put back** copies a kept copy without renaming it.
- **Crash at each step:** test hooks throw after each step, for create, for replace and for a public update. After each, reopen with a new runtime and check that the recovery table applies: the old content is always either at `<name>` or in its kept copy, the folder ends at the new revision, the marker is gone, and nothing outside Konfab's claim and private folders changed.
- **Resolve actions:** each `code` and action, including a 409 when the reason changed meanwhile.
- **Saved versus ready:** force a write failure after commit (library folder made read-only), then check `folder: "pending"` with the reason, no "Imported" message, Retry succeeding once writable, and the row notice clearing. Do the same for a concurrent edit after confirmation: create the target folder, or edit the replaced skill's folder, between the commit and `finishWorkspaces` (test hook). The result is pending, nothing is overwritten, and the edit is kept.
- **Restart (integration):** commit an import, close before `finishWorkspaces`, then reopen with `createRuntime` + `buildApp`. The folder is written and the API lists the skill. A folder created in between is left alone and the operation stays pending.
- **API:** the routes, body limit, cookie auth and an unavailable project library.
- **Browser (Playwright, both themes):** import a folder with `setInputFiles` (directory), rename, hit a collision → Replace → History shows both revisions; import a single file; check that the stale-preview message appears after an outside edit.
- **Manual, before merge:** the symlink behaviour in Chrome's native dialog and in Safari, recorded here. A Playwright check keeps the measured Chromium behaviour from regressing, and keeps the warning always shown for folder imports.

## Out of scope

Importing several skills at once, `.zip` archives, drag-and-drop (a later addition that can feed the same preview), and keeping file modes.

## Implementation notes

- **Code:**
  - `src/server/domain/local-import.ts`: normalising the upload, choosing the skill file, `renameManifest` (now shared with the public import) and the licence.
  - `src/server/domain/skill-workspace.ts`: the create-only, journaled folder writer, used for every working-folder write.
  - `SkillLibrary.prepareLocalImport`, `importLocal`, `resolveWorkspace`, and kept folders.
  - `web/src/LocalImport.tsx`.
  - Schema v34 adds the journal columns and `skill_kept_folders`.
- **Resolve actions shipped:** **Move the other folder aside** (`folder_exists`), **Save my edits first** and **Use the import, keep my edits aside** (`folder_edited`), and **Retry**. Not shipped yet: **Rename this skill** and **Move to Trash** on a pending import, and **Put back** for a kept copy. Moving aside and Retry cover each case without them.
- **Kept copies** are listed with **Copy path** rather than **Open**, because the page can't open Finder.
- **Browsers:**
  - Playwright's Chromium is checked by `tests/e2e/local-import.spec.ts`: a linked file is left out without notice.
  - Chrome's native dialog and Safari still need the manual check before merge.
