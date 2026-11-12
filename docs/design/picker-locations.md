# Picker location hints

Show a muted hint for each active filter and matching tooltips. Read the configured personal role-library root, personal skill path and current room project path from an authenticated local API; do not assume the default home. The role hint distinguishes built-in roles from the personal library. The project hint explains setup if no project folder is configured, without creating a folder. Public hints describe enabled sources generically. A path indicates where the library is or would be stored, not proof that a directory already exists.

Combine filters as before; show relevant empty guidance for explicitly selected categories and a search-specific no-match message. Show public progress only while All or Public is selected. Keep source fetching and assignment behavior unchanged. Tests use synthetic paths and cover alternate home, missing project, multi-filter empty states and search. Review before commit.
