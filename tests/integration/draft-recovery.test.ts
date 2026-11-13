import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { parseConfig } from "../../src/server/config.js";
import { createRuntime } from "../../src/server/runtime.js";

const PORT = 18795;
const HOST = `127.0.0.1:${PORT}`;
const noNetwork = {
  fetch: async () => {
    throw new Error("no network expected");
  },
};

describe("import drafts from an earlier version", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("are recovered when the server starts and can be adopted with their provenance", async () => {
    home = mkdtempSync(join(tmpdir(), "konfab-draft-app-"));
    mkdirSync(join(home, "skills"));
    const path = join(home, "konfab.db");
    const config = parseConfig("");
    // First run: the library exists and an old version left a draft behind.
    const first = createRuntime(path, config, noNetwork);
    const libraryId = first.skills.registerLibrary(
      "personal",
      join(home, "skills"),
    );
    first.db
      .prepare(
        "INSERT INTO skill_import_drafts(id, library_id, folder_name, provenance_json, licence, diagnostic, revision, created_at, updated_at) VALUES ('dd', ?, 'web-check', ?, 'Apache-2.0', 'Saved as a draft', 2, 1, 2)",
      )
      .run(
        libraryId,
        JSON.stringify({
          source: { owner: "example", repository: "skills" },
          commit: "e".repeat(40),
          path: "skills/web-check",
        }),
      );
    first.db
      .prepare(
        "INSERT INTO skill_import_draft_files(draft_id, path, content, mode) VALUES ('dd', 'SKILL.md', ?, 384)",
      )
      .run(
        Buffer.from(
          "---\nname: web-check\ndescription: Checks web pages\n---\nMy edited steps",
        ),
      );
    await first.sources.close();
    first.db.close();

    // Restart: a new runtime and app over the reopened database.
    const second = createRuntime(path, config, noNetwork);
    const app = await buildApp({
      service: second.service,
      skills: second.skills,
      sources: second.sources,
      skillsHome: home,
      port: PORT,
    });
    try {
      const login = await app.inject({
        method: "GET",
        url: `/login?code=${second.service.createLoginCode()}`,
        headers: { host: HOST },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
      const call = (method: "GET" | "POST", url: string, payload?: object) =>
        app.inject({
          method,
          url,
          headers: { host: HOST, cookie },
          ...(payload ? { payload } : {}),
        });
      const library = (await call("GET", "/api/library?scope=personal")).json();
      expect(library.untracked).toContain("web-check");
      expect(
        readFileSync(join(home, "skills", "web-check", "SKILL.md"), "utf8"),
      ).toContain("My edited steps");
      expect(
        existsSync(
          join(home, "skills", ".konfab-recovered-drafts", "web-check.json"),
        ),
      ).toBe(true);
      const adopted = await call("POST", "/api/library/adopt", {
        scope: "personal",
        folder: "web-check",
      });
      expect(adopted.statusCode).toBe(200);
      const detail = (
        await call("GET", `/api/library/skills/${adopted.json().id}`)
      ).json();
      expect(JSON.parse(detail.provenance_json)).toEqual({
        source: { owner: "example", repository: "skills" },
        commit: "e".repeat(40),
        path: "skills/web-check",
        recovered_from_draft: "dd",
      });
      expect(detail.licence).toBe("Apache-2.0");
    } finally {
      await app.close();
      await second.sources.close();
      second.db.close();
    }
  });
});
