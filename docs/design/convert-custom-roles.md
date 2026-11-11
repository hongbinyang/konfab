# Convert custom roles

Status: implementation proposal. Convert only non-empty custom-text assignments;
existing pack assignments are excluded. Preview groups identical text by exact
bytes, with editable names and explicit selection. Preserve each original text in
local assignment history before any optional reassignment. Never infer skills.

The request carries each room/member's assignment revision and exact original
text (or a hash), plus the chosen names and assign choice. Recheck membership,
absence of an existing role-pack assignment, exact text, revision and collisions
inside a transaction. Create one personal role per exact-text group and assign
all selected members only if every check succeeds. Persist the originals and the
resulting assignment token for an explicit, conflict-checked revert. If the
filesystem cannot be completed, preserve data and expose pending recovery; never
overwrite an existing folder. No automatic migration occurs.

Test identical and differing text, selection, name conflicts, rollback, concurrent
changes, revert and database reopen; browser-check preview and confirmation.
