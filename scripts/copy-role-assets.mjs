import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/server/roles", { recursive: true });
cpSync("src/server/roles/builtin", "dist/server/roles/builtin", {
  recursive: true,
});
