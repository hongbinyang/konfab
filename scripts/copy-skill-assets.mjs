import { cpSync, mkdirSync, rmSync } from "node:fs";

// Built-in roles were replaced by built-in skills; remove any stale copy from an earlier build.
rmSync("dist/server/roles", { recursive: true, force: true });
mkdirSync("dist/server/skills", { recursive: true });
cpSync("src/server/skills/builtin", "dist/server/skills/builtin", {
  recursive: true,
});
