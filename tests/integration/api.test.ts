import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import { SkillSources } from "../../src/server/domain/skill-sources.js";
import { KonfabService } from "../../src/server/domain/service.js";

const PORT = 18788;
const HOST = `127.0.0.1:${PORT}`;

describe("page API", () => {
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let sources: SkillSources;
  let sourceFetch: typeof fetch;
  let cookie: string;
  let attachmentDir: string;

  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, cookie },
      ...(payload ? { payload } : {}),
    });

  beforeEach(async () => {
    db = openDatabase(":memory:");
    attachmentDir = mkdtempSync(join(tmpdir(), "konfab-attachments-"));
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
      attachmentDir,
      maxAttachmentBytes: 1024,
    });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    sourceFetch = async () => {
      throw new Error("unexpected network request");
    };
    sources = new SkillSources(db, {
      fetch: (input, init) => sourceFetch(input, init),
    });
    const skills = new SkillLibrary(db);
    skills.seedBuiltins("src/server/skills/builtin");
    app = await buildApp({
      service,
      skills,
      sources,
      skillsHome: attachmentDir,
      port: PORT,
    });

    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });

  it("changes the overview instance identifier after reopening the database and app", async () => {
    const path = join(attachmentDir, "restart.db");
    const options = {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
      attachmentDir,
      maxAttachmentBytes: 1024,
    };
    const diskDb = openDatabase(path);
    const diskService = new KonfabService(diskDb, options);
    const firstApp = await buildApp({ service: diskService, port: PORT });
    const login = await firstApp.inject({
      method: "GET",
      url: `/login?code=${diskService.createLoginCode()}`,
      headers: { host: HOST },
    });
    const diskCookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const overview = () => ({
      method: "GET" as const,
      url: "/api/overview",
      headers: { host: HOST, cookie: diskCookie },
    });
    const first = (await firstApp.inject(overview())).json().instance_id;
    expect((await firstApp.inject(overview())).json().instance_id).toBe(first);
    await firstApp.close();
    diskDb.close();
    const reopened = openDatabase(path);
    const nextApp = await buildApp({
      service: new KonfabService(reopened, options),
      port: PORT,
    });
    try {
      const result = await nextApp.inject(overview());
      expect(result.statusCode).toBe(200);
      expect(result.json().instance_id).not.toBe(first);
    } finally {
      await nextApp.close();
      reopened.close();
    }
  });

  it("restricts permanent room deletion to signed-in page requests with an exact confirmation", async () => {
    const room = service.createRoom("dispose", "", ["claude"]);
    service.postUserMessage(room.id, "example");
    const url = `/api/rooms/${room.id}/delete`;
    const unauthenticated = await app.inject({
      method: "POST",
      url,
      headers: { host: HOST },
      payload: { name: "dispose" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect((await call("POST", url, { name: "dispose" })).statusCode).toBe(409);
    service.archiveRoom(room.id);
    expect(
      (await call("GET", `/api/rooms/${room.id}/deletion-preview`)).json()
        .counts.messages,
    ).toBe(1);
    expect((await call("POST", url, { name: "incorrect" })).statusCode).toBe(
      400,
    );
    const deleted = await call("POST", url, { name: "dispose" });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().counts.messages).toBe(1);
    expect((await call("GET", `/api/rooms/${room.id}`)).statusCode).toBe(404);
  });

  it("returns configured picker locations without creating skill directories", async () => {
    const room = service.createRoom("picker-locations", "", ["claude"]);
    const path = `/api/rooms/${room.id}/picker-locations`;
    const initial = (await call("GET", path)).json();
    expect(initial.skills).toBe(join(attachmentDir, "skills"));
    expect(initial.project).toBeNull();
    expect(initial.sources).toEqual(
      sources
        .list()
        .filter((source) => source.enabled === 1)
        .map((source) => `${source.owner}/${source.repository}`),
    );
    expect(existsSync(join(attachmentDir, "skills"))).toBe(false);
    service.updateRoom(room.id, { project_path: attachmentDir });
    const project = service.roomState(room.id).room.project_path!;
    expect((await call("GET", path)).json().project).toBe(
      join(project, ".konfab", "skills"),
    );
    expect(existsSync(join(project, ".konfab", "skills"))).toBe(false);
    const denied = await app.inject({
      method: "GET",
      url: path,
      headers: { host: HOST },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("validates and clears a room check-in override", async () => {
    const room = service.createRoom("checkin", "", ["claude"]);
    const path = `/api/rooms/${room.id}`;
    expect((await call("GET", path)).json().room).toMatchObject({
      checkin_minutes: null,
      checkin_default: 2,
    });
    expect((await call("PATCH", path, { checkin_minutes: 3 })).statusCode).toBe(
      400,
    );
    expect(
      (await call("PATCH", path, { checkin_minutes: 10 })).json().room
        .checkin_minutes,
    ).toBe(10);
    expect(
      (await call("PATCH", path, { checkin_minutes: null })).json().room
        .checkin_minutes,
    ).toBeNull();
  });

  it("sets, validates and clears a member's room name", async () => {
    const created = await call("POST", "/api/rooms", {
      name: "names",
      members: ["claude", "codex"],
    });
    const id = (created.json() as { id: number }).id;
    const name = (agent: string, body?: object) =>
      call(
        body ? "PUT" : "DELETE",
        `/api/rooms/${id}/members/${agent}/name`,
        body,
      );
    expect((await name("claude", { name: "A" })).statusCode).toBe(200);
    const conflict = await name("codex", { name: "a" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "name_conflict" });
    expect((await name("codex", { name: "lead" })).json()).toMatchObject({
      code: "name_reserved",
    });
    expect((await name("codex", { name: "two words" })).statusCode).toBe(400);
    expect((await name("codex", {})).statusCode).toBe(400);
    expect((await name("nobody", { name: "N" })).statusCode).toBe(404);
    const state = (await call("GET", `/api/rooms/${id}`)).json() as {
      agents: { id: string; room_name: string | null; name_fixed: boolean }[];
      room_names: Record<string, string>;
    };
    expect(state.room_names).toEqual({ claude: "A" });
    expect(state.agents[0]).toMatchObject({
      id: "claude",
      room_name: "A",
      name_fixed: false,
    });
    expect((await name("claude")).statusCode).toBe(200);
    service.join("codex", "names");
    expect((await name("codex", { name: "B" })).json()).toMatchObject({
      code: "name_fixed",
    });
    const added = await call("POST", "/api/agents", {
      id: "claude-two",
      display_name: "Second",
      app_id: "claude",
      room_id: id,
      room_name: "Codex",
    });
    expect(added.json()).toMatchObject({ code: "name_conflict" });
    expect(
      (
        await call("POST", "/api/agents", {
          id: "claude-two",
          display_name: "Second",
          app_id: "claude",
          room_id: id,
          room_name: "C",
        })
      ).statusCode,
    ).toBe(201);
  });

  it("reports actionable field errors for assignment and skill requests", async () => {
    for (const [url, payload, field] of [
      [
        "/api/library/skills",
        { scope: "personal", name: "valid", description: "" },
        "description",
      ],
    ] as const) {
      const response = await call("POST", url, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(field);
      expect(response.json().message).not.toBe("Invalid request");
    }
    const assignment = await call(
      "PUT",
      "/api/rooms/1/members/codex/assignment",
      { pins: [] },
    );
    expect(assignment.statusCode).toBe(400);
    expect(assignment.json().message).toContain("base_revision");
    expect(assignment.json().message).not.toBe("Invalid request");
    const badOwner = await call("POST", "/api/library/sources", {
      owner: "a b",
      repository: "skills",
      ref: "HEAD",
    });
    expect(badOwner.json().message).toContain("Owner");
    expect(badOwner.json().message).toContain("no spaces");
  });

  /** Serves one public skill from a fake GitHub source and returns its picker pin. */
  const publicSkill = async (manifest: string, commit = "a".repeat(40)) => {
    const hash = createHash("sha1")
      .update(`blob ${Buffer.byteLength(manifest)}\0`)
      .update(manifest)
      .digest("hex");
    sourceFetch = async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha: commit }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "skills/public-sample/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: hash,
                size: Buffer.byteLength(manifest),
              },
            ],
          }),
        );
      return new Response(manifest);
    };
    await call("GET", "/api/library/live?q=invoice");
    await vi.waitFor(async () =>
      expect(
        (await call("GET", "/api/library/live?q=invoice")).json().items.length,
      ).toBeGreaterThan(0),
    );
    const result = (await call("GET", "/api/library/live?q=invoice")).json()
      .items[0];
    const query = new URLSearchParams({
      source_id: result.source_id,
      commit,
      path: result.path,
    });
    const preview = (
      await call("GET", `/api/library/live/preview?${query}`)
    ).json();
    return {
      source_id: result.source_id as string,
      commit,
      path: result.path as string,
      preview_hash: preview.preview_hash as string,
    };
  };

  it("adds no agent when a chosen public skill clashes, then adds it with the chosen copy name", async () => {
    const room = service.createRoom("public-agent", "", ["codex"]);
    // A different local skill already uses the public skill's name.
    await call("POST", "/api/library/skills", {
      scope: "personal",
      name: "public-sample",
      description: "Mine",
    });
    const pin = await publicSkill(
      "---\nname: public-sample\ndescription: Invoice workflow\n---\nBody",
    );
    const body = (copy?: string) => ({
      id: "invoicer",
      display_name: "Invoicer",
      app_id: "claude",
      room_id: room.id,
      assignment: {
        pins: [{ public: { ...pin, ...(copy ? { copy_name: copy } : {}) } }],
        confirmed: true,
      },
    });
    const clash = await call("POST", "/api/agents", body());
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "name_conflict", pin: 0 });
    expect(
      service.overview().agents.some((agent) => agent.id === "invoicer"),
    ).toBe(false);
    expect(
      (await call("GET", "/api/library?scope=personal")).json().skills,
    ).toHaveLength(1);
    const added = await call("POST", "/api/agents", body("public-sample-2"));
    expect(added.statusCode).toBe(201);
    expect(
      service.roomState(room.id).agents.find((agent) => agent.id === "invoicer")
        ?.assignment.label,
    ).toBe("public-sample-2 rev 1");
  });

  it("names the exact saved revision when a public skill has local changes, and assigns only that revision", async () => {
    const room = service.createRoom("keep-local", "", ["codex"]);
    const url = `/api/rooms/${room.id}/members/codex/assignment`;
    const upstream = await publicSkill(
      "---\nname: public-sample\ndescription: Invoice workflow\n---\nupstream",
    );
    expect(
      (
        await call("PUT", url, {
          base_revision: 0,
          pins: [{ public: upstream }],
        })
      ).statusCode,
    ).toBe(200);
    const library = new SkillLibrary(db);
    const imported = (await call("GET", url)).json().skills[0] as {
      skill_id: string;
      revision_id: string;
    };
    const id = imported.skill_id;
    // The lead edits their copy and saves it as rev 2 (not reviewed yet).
    library.writeFile(
      id,
      "notes.md",
      Buffer.from("mine"),
      imported.revision_id,
      library.detail(id).draft_hash!,
    );
    const mine = library.save(
      id,
      imported.revision_id,
      library.detail(id).draft_hash!,
    );
    const clash = await call("PUT", url, {
      base_revision: 1,
      pins: [{ public: upstream }],
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({
      code: "local_changes",
      pin: 0,
      local: {
        skill_id: id,
        revision_id: mine,
        name: "public-sample",
        number: 2,
        reviewed: false,
        draft: false,
      },
    });
    // The old silent "keep" request field is ignored: it still asks.
    expect(
      (
        await call("PUT", url, {
          base_revision: 1,
          pins: [{ public: { ...upstream, keep_local: true } }],
        })
      ).statusCode,
    ).toBe(409);
    // Keeping it is an ordinary pin to the exact revision shown: unreviewed, it needs review.
    const pin = { skill_id: id, revision_id: mine };
    expect(
      (await call("PUT", url, { base_revision: 1, pins: [pin] })).statusCode,
    ).toBe(409);
    // Meanwhile the lead saves rev 3. Confirming assigns exactly rev 2, as shown.
    library.writeFile(
      id,
      "notes.md",
      Buffer.from("newer"),
      mine,
      library.detail(id).draft_hash!,
    );
    const newer = library.save(id, mine, library.detail(id).draft_hash!);
    const kept = await call("PUT", url, {
      base_revision: 1,
      pins: [pin],
      review: [mine],
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().skills[0]).toMatchObject({
      revision_id: mine,
      number: 2,
      reviewed: true,
      latest: { id: newer, number: 3 },
    });
    expect(
      (await call("GET", `/api/library/skills/${id}`)).json().reviewed_at,
    ).toBeNull();
  });

  it("discovers, previews and assigns a pinned public skill without persisting the search", async () => {
    const commit = "a".repeat(40);
    const manifest =
      "---\nname: public-sample\ndescription: Invoice workflow\nlicense: MIT\n---\nBody";
    const hash = createHash("sha1")
      .update(`blob ${Buffer.byteLength(manifest)}\0`)
      .update(manifest)
      .digest("hex");
    sourceFetch = async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha: commit }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "skills/public-sample/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: hash,
                size: Buffer.byteLength(manifest),
              },
            ],
          }),
        );
      return new Response(manifest);
    };
    const room = service.createRoom("live-picker", "", ["codex"]);
    const snapshotFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory()
            ? snapshotFiles(path)
            : [
                `${path.slice(attachmentDir.length)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
              ];
        })
        .sort();
    const snapshotRows = () =>
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => [
        name,
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`,
            )
            .get() as { n: number }
        ).n,
      ]);
    const beforeFiles = snapshotFiles(attachmentDir);
    const beforeRows = snapshotRows();
    const before = db.prepare("SELECT COUNT(*) AS count FROM skills").get() as {
      count: number;
    };
    await call("GET", "/api/library/live?q=invoice");
    await vi.waitFor(async () =>
      expect(
        (await call("GET", "/api/library/live?q=invoice")).json().items.length,
      ).toBeGreaterThan(0),
    );
    const result = (await call("GET", "/api/library/live?q=invoice")).json()
      .items[0];
    const query = new URLSearchParams({
      source_id: result.source_id,
      commit,
      path: result.path,
    });
    const preview = (
      await call("GET", `/api/library/live/preview?${query}`)
    ).json();
    expect(preview.content).toBe(manifest);
    const previewFile = new URLSearchParams({
      source_id: result.source_id,
      commit,
      path: result.path,
      file: "SKILL.md",
    });
    expect(
      (await call("GET", `/api/library/live/file?${previewFile}`)).statusCode,
    ).toBe(200);
    expect(snapshotFiles(attachmentDir)).toEqual(beforeFiles);
    expect(snapshotRows()).toEqual(beforeRows);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM skills").get() as {
          count: number;
        }
      ).count,
    ).toBe(before.count);
    const url = `/api/rooms/${room.id}/members/codex/assignment`;
    const publicPin = {
      public: {
        source_id: result.source_id,
        commit,
        path: result.path,
        preview_hash: preview.preview_hash,
      },
    };
    const stalePublic = await call("PUT", url, {
      base_revision: 99,
      pins: [publicPin],
    });
    expect(stalePublic.statusCode).toBe(409);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM skills").get() as {
          count: number;
        }
      ).count,
    ).toBe(before.count);
    expect(existsSync(join(attachmentDir, "skills", "public-sample"))).toBe(
      false,
    );
    const assigned = await call("PUT", url, {
      base_revision: 0,
      pins: [publicPin],
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().skills).toEqual([
      expect.objectContaining({
        name: "public-sample",
        reviewed: true,
        delivery: "full",
      }),
    ]);
    expect(
      existsSync(join(attachmentDir, "skills", "public-sample", "SKILL.md")),
    ).toBe(true);
    // Adding the same commit again reuses the local copy instead of failing on its name.
    const again = await call("PUT", url, {
      base_revision: 1,
      pins: [publicPin],
    });
    expect(again.statusCode).toBe(200);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM skills").get() as {
          count: number;
        }
      ).count,
    ).toBe(before.count + 1);
  });

  it("adds an agent with its app and room skills in one step", async () => {
    const room = service.createRoom("add-agent", "", ["codex"]);
    const builtin = (await call("GET", "/api/library/builtin")).json()
      .skills as Array<{
      id: string;
      name: string;
      current_revision_id: string;
    }>;
    const skill = builtin.find((item) => item.name === "reviewer")!;
    const pins = [
      { skill_id: skill.id, revision_id: skill.current_revision_id },
    ];
    const unconfirmed = await call("POST", "/api/agents", {
      id: "reviewer",
      display_name: "Reviewer",
      app_id: "claude",
      room_id: room.id,
      assignment: { pins },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(
      service.overview().agents.some((item) => item.id === "reviewer"),
    ).toBe(false);
    const confirmed = await call("POST", "/api/agents", {
      id: "reviewer",
      display_name: "Reviewer",
      app_id: "claude",
      room_id: room.id,
      assignment: { pins, confirmed: true },
    });
    expect(confirmed.statusCode).toBe(201);
    const agent = service
      .roomState(room.id)
      .agents.find((item) => item.id === "reviewer");
    expect(agent?.assignment.label).toBe("reviewer rev 1");
    expect(
      service.overview().agents.find((item) => item.id === "reviewer")?.app_id,
    ).toBe("claude");

    const badSkill = await call("POST", "/api/agents", {
      id: "tester",
      display_name: "Tester",
      app_id: "codex",
      room_id: room.id,
      assignment: {
        pins: [
          {
            skill_id: skill.id,
            revision_id: "00000000-0000-4000-8000-000000000000",
          },
        ],
        confirmed: true,
      },
    });
    expect(badSkill.statusCode).toBe(409);
    expect(service.overview().agents.some((item) => item.id === "tester")).toBe(
      false,
    );

    const noRoom = await call("POST", "/api/agents", {
      id: "tester",
      display_name: "Tester",
      app_id: "codex",
      assignment: { pins, confirmed: true },
    });
    expect(noRoom.statusCode).toBe(400);

    const plain = await call("POST", "/api/agents", {
      id: "tester",
      display_name: "Tester",
      app_id: "codex",
    });
    expect(plain.statusCode).toBe(201);
    expect(
      service.roomState(room.id).agents.some((item) => item.id === "tester"),
    ).toBe(false);
  });

  it("assigns several skills in order, measures them, and rejects stale or oversized assignments", async () => {
    const room = service.createRoom("assign-test", "", ["codex"]);
    const builtin = (await call("GET", "/api/library/builtin")).json()
      .skills as Array<{
      id: string;
      name: string;
      current_revision_id: string;
    }>;
    const pin = (name: string, delivery = "full") => {
      const skill = builtin.find((item) => item.name === name)!;
      return {
        skill_id: skill.id,
        revision_id: skill.current_revision_id,
        delivery,
      };
    };
    // Built-in skills open in the library like any other skill.
    for (const skill of builtin)
      expect(
        (await call("GET", `/api/library/skills/${skill.id}`)).statusCode,
      ).toBe(200);
    const url = `/api/rooms/${room.id}/members/codex/assignment`;
    const pins = [pin("reviewer"), pin("qa", "summary")];
    const size = await call("POST", `${url}/size`, {
      instructions: "Example notes",
      pins,
    });
    expect(size.json().limit).toBe(64 * 1024);
    expect(size.json().bytes).toBeGreaterThan(100);
    const assigned = await call("PUT", url, {
      base_revision: 0,
      instructions: "Example notes",
      pins,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      revision: 1,
      instructions: "Example notes",
      skills: [
        expect.objectContaining({ name: "reviewer", position: 1 }),
        expect.objectContaining({
          name: "qa",
          position: 2,
          delivery: "summary",
        }),
      ],
    });
    expect(
      (await call("PUT", url, { base_revision: 4, pins: [] })).statusCode,
    ).toBe(409);
    const duplicate = await call("PUT", url, {
      base_revision: 1,
      pins: [pin("qa"), pin("qa")],
    });
    expect(duplicate.statusCode).toBe(400);
    // A long skill fits only as a summary; the full text would exceed 64 KiB.
    const library = new SkillLibrary(db);
    const libraryId = library.registerLibrary(
      "personal",
      (() => {
        const root = join(attachmentDir, "skills");
        mkdirSync(root, { recursive: true });
        return root;
      })(),
    );
    const longId = library.create(libraryId, "long-skill", "Long skill");
    const longDetail = library.detail(longId);
    library.writeFile(
      longId,
      "SKILL.md",
      Buffer.from(
        `---\nname: long-skill\ndescription: Long skill\n---\n${"x".repeat(70 * 1024)}`,
      ),
      longDetail.current_revision_id,
      longDetail.draft_hash!,
    );
    const longRevision = library.save(
      longId,
      longDetail.current_revision_id,
      library.detail(longId).draft_hash!,
    );
    const long = { skill_id: longId, revision_id: longRevision };
    const oversized = await call("PUT", url, {
      base_revision: 1,
      pins: [long],
      review: [longRevision],
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().message).toContain("Send summary");
    expect(service.roomState(room.id).agents[0]?.assignment.revision).toBe(1);
    const summary = await call("PUT", url, {
      base_revision: 1,
      pins: [{ ...long, delivery: "summary" }],
      review: [longRevision],
    });
    expect(summary.statusCode).toBe(200);
    expect(service.roomState(room.id).agents[0]?.assignment).toMatchObject({
      label: "long-skill rev 2",
      revision: 2,
    });
  });

  afterEach(async () => {
    await sources.close();
    await app.close();
    db.close();
    rmSync(attachmentDir, { recursive: true, force: true });
  });

  it("lists public sources without fetching and manages source settings", async () => {
    const list = await call("GET", "/api/library/sources");
    expect(list.statusCode).toBe(200);
    expect(list.json().sources).toHaveLength(7);
    const created = await call("POST", "/api/library/sources", {
      owner: "example",
      repository: "skills",
      ref: "main",
    });
    expect(created.statusCode).toBe(200);
    expect((await call("GET", "/api/library/sources")).json().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: "example", repository: "skills" }),
      ]),
    );
    expect(
      (
        await call(
          "PUT",
          `/api/library/sources/${created.json().id as string}`,
          { enabled: false },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call("PUT", "/api/library/source-token", {
          enabled: true,
          acknowledged: true,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("maps an empty JSON request body to a client error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/library/sources",
      headers: {
        host: HOST,
        cookie,
        "content-type": "application/json",
      },
      payload: "",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_request");
  });

  it("assigns a local skill only with review, and updates selected members to a new revision", async () => {
    const room = service.createRoom("picker", "", ["claude", "codex"]);
    const created = await call("POST", "/api/library/skills", {
      scope: "personal",
      name: "review-change",
      description: "Review changes",
    });
    const skillId = created.json().id as string;
    const detail = (await call("GET", `/api/library/skills/${skillId}`)).json();
    const revision = detail.current_revision_id as string;
    const url = (agent: string) =>
      `/api/rooms/${room.id}/members/${agent}/assignment`;
    const pins = [{ skill_id: skillId, revision_id: revision }];
    const unreviewed = await call("PUT", url("codex"), {
      base_revision: 0,
      pins,
    });
    expect(unreviewed.statusCode).toBe(409);
    expect(unreviewed.json().message).toContain("Review");
    const stale = await call("PUT", url("codex"), {
      base_revision: 99,
      pins,
      review: [revision],
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await call("GET", `/api/library/skills/${skillId}`)).json().reviewed_at,
    ).toBeNull();
    for (const agent of ["claude", "codex"])
      expect(
        (
          await call("PUT", url(agent), {
            base_revision: 0,
            pins,
            review: [revision],
          })
        ).statusCode,
      ).toBe(200);
    // Save a new revision, then update only one member to it.
    const library = new SkillLibrary(db);
    const folder = join(attachmentDir, "skills", "review-change");
    library.writeFile(
      skillId,
      "SKILL.md",
      Buffer.from("---\nname: review-change\ndescription: Review v2\n---\nv2"),
      revision,
      library.detail(skillId).draft_hash!,
    );
    const second = library.save(
      skillId,
      revision,
      library.detail(skillId).draft_hash!,
    );
    expect(existsSync(folder)).toBe(true);
    const usages = (
      await call("GET", `/api/library/skills/${skillId}/usages`)
    ).json().usages as Array<{ agent_id: string; base_revision: number }>;
    expect(usages.map((usage) => usage.agent_id).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(
      service
        .roomState(room.id)
        .agents.every((agent) => agent.assignment.update_available),
    ).toBe(true);
    const codex = usages.find((usage) => usage.agent_id === "codex")!;
    const update = `/api/library/skills/${skillId}/update-assignments`;
    expect(
      (
        await call("POST", update, {
          revision_id: second,
          targets: [{ room_id: room.id, agent_id: "codex", base_revision: 9 }],
          review: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call("POST", update, {
          revision_id: second,
          targets: [
            {
              room_id: room.id,
              agent_id: "codex",
              base_revision: codex.base_revision,
            },
          ],
          review: true,
        })
      ).statusCode,
    ).toBe(200);
    const agents = service.roomState(room.id).agents;
    expect(agents.find((a) => a.id === "codex")?.assignment).toMatchObject({
      label: "review-change rev 2",
      update_available: false,
    });
    expect(agents.find((a) => a.id === "claude")?.assignment).toMatchObject({
      label: "review-change rev 1",
      update_available: true,
    });
  });

  it("creates and lists a local skill through authenticated page routes", async () => {
    const created = await call("POST", "/api/library/skills", {
      scope: "personal",
      name: "review-change",
      description: "Review a change",
    });
    expect(created.statusCode).toBe(200);
    const list = await call("GET", "/api/library?scope=personal");
    expect(list.statusCode).toBe(200);
    expect(list.json().skills).toHaveLength(1);
    const id = created.json().id as string;
    const detail = await call("GET", `/api/library/skills/${id}`);
    expect(detail.json().name).toBe("review-change");
    expect(detail.json().reviewed_at).toBeNull();
    const written = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "SKILL.md",
      content_base64: Buffer.from(
        "---\nname: review-change\ndescription: Updated\n---\nBody",
      ).toString("base64"),
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: detail.json().draft_hash,
    });
    expect(written.statusCode).toBe(200);
    const conflict = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "SKILL.md",
      content_base64: "WA==",
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: detail.json().draft_hash,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("draft_conflict");
    const invalid = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "../escape",
      content_base64: "WA==",
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: written.json().draft_hash,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("invalid_path");
    const saved = await call("POST", `/api/library/skills/${id}/save`, {
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: written.json().draft_hash,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await call("GET", `/api/library/skills/${id}`)).json().description,
    ).toBe("Updated");
  });

  it("lets the lead disable automatic continuation", async () => {
    const created = await call("POST", "/api/rooms", {
      name: "auto-control",
      members: ["claude"],
    });
    const id = created.json().id;
    const updated = await call("PUT", `/api/rooms/${id}/auto-continue`, {
      enabled: false,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().routing.auto_continue_enabled).toBe(false);
    expect(
      (await call("GET", `/api/rooms/${id}`)).json().routing
        .auto_continue_enabled,
    ).toBe(false);
  });

  describe("sign-in", () => {
    it("sets a protected cookie and redirects", async () => {
      const login = await app.inject({
        method: "GET",
        url: `/login?code=${service.createLoginCode()}`,
        headers: { host: HOST },
      });
      expect(login.statusCode).toBe(303);
      expect(login.headers.location).toBe("/");
      const value = String(login.headers["set-cookie"]);
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/");
    });

    it("rejects a reused or invalid code", async () => {
      const code = service.createLoginCode();
      const request = {
        method: "GET" as const,
        url: `/login?code=${code}`,
        headers: { host: HOST },
      };
      expect((await app.inject(request)).statusCode).toBe(303);
      expect((await app.inject(request)).statusCode).toBe(401);
    });

    it("blocks page routes without a valid session", async () => {
      for (const headers of [
        { host: HOST },
        { host: HOST, cookie: "konfab_session=wrong" },
      ]) {
        for (const url of [
          "/api/overview",
          "/api/events",
          "/api/rooms/1",
          "/api/library?scope=personal",
        ]) {
          const response = await app.inject({ method: "GET", url, headers });
          expect(response.statusCode).toBe(401);
        }
      }
    });
  });

  describe("request protection", () => {
    it("rejects an untrusted host, even with a valid session", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "evil.test", cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("rejects an untrusted origin, even with a valid session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { host: HOST, cookie, origin: "https://evil.test" },
        payload: { name: "attack" },
      });
      expect(response.statusCode).toBe(403);
      expect(service.overview().rooms).toEqual([]);
    });

    it("sets a strict content security policy", async () => {
      const policy = (await call("GET", "/api/overview")).headers[
        "content-security-policy"
      ];
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).not.toContain("unsafe");
    });

    it("does not let an agent token use page routes", async () => {
      service.setAgentToken("claude", "agent-token");
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: HOST, authorization: "Bearer agent-token" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("does not let a page session use agent routes", async () => {
      const response = await call("POST", "/agent/join", { room: "any" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects invalid input", async () => {
      expect((await call("POST", "/api/rooms", {})).statusCode).toBe(400);
      expect((await call("GET", "/api/rooms/abc")).statusCode).toBe(400);
    });
  });

  describe("rooms", () => {
    const createRoom = async () => {
      const response = await call("POST", "/api/rooms", {
        name: "design",
        topic: "Topic",
        members: ["claude"],
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { id: number }).id;
    };

    it("creates, updates, and lists rooms", async () => {
      const id = await createRoom();
      const updated = await call("PATCH", `/api/rooms/${id}`, {
        name: "renamed",
        topic: "New topic",
      });
      expect(updated.json().room).toMatchObject({
        name: "renamed",
        topic: "New topic",
      });
      const overview = (await call("GET", "/api/overview")).json();
      expect(overview.rooms).toHaveLength(1);
      expect(overview.agents).toHaveLength(2);
    });

    it("rejects a duplicate room", async () => {
      await createRoom();
      const response = await call("POST", "/api/rooms", { name: "design" });
      expect(response.statusCode).toBe(409);
    });

    it("returns 404 for an unknown room", async () => {
      expect((await call("GET", "/api/rooms/999")).statusCode).toBe(404);
    });

    it("changes members, pauses, posts, and archives", async () => {
      const id = await createRoom();
      const members = await call("PUT", `/api/rooms/${id}/members`, {
        members: ["claude", "codex"],
      });
      expect(members.json().agents).toHaveLength(2);

      await call("POST", `/api/rooms/${id}/pause`, { paused: true });
      expect((await call("GET", `/api/rooms/${id}`)).json().room.paused).toBe(
        true,
      );

      const posted = await call("POST", `/api/rooms/${id}/messages`, {
        body: "Hello",
      });
      expect(posted.statusCode).toBe(200);

      await call("POST", `/api/rooms/${id}/archive`);
      const blocked = await call("POST", `/api/rooms/${id}/messages`, {
        body: "More",
      });
      expect(blocked.statusCode).toBe(409);
    });

    it("pauses all rooms", async () => {
      await call("POST", "/api/pause-all", { paused: true });
      expect((await call("GET", "/api/overview")).json().paused_all).toBe(true);
    });

    it("answers a permission request and dismisses a report", async () => {
      await createRoom();
      const session = service.join("claude", "design").session_id;
      const request = service.requestPermission("claude", session, {
        recipient: "example.com",
        data_description: "Data",
        reason: "Reason",
      });
      const decided = await call(
        "POST",
        `/api/permissions/${request.id}/decision`,
        { decision: "denied" },
      );
      expect(decided.json().state).toBe("denied");

      const { report_id: reportId } = service.reportStatus(
        "claude",
        session,
        "other",
        "Note",
      );
      const dismissed = await call("POST", `/api/reports/${reportId}/dismiss`);
      expect(dismissed.statusCode).toBe(200);
    });
  });

  it("updates the room brief and a member's edit permission", async () => {
    const { id } = service.createRoom("team", "", ["claude", "codex"]);
    const brief = await call("PATCH", `/api/rooms/${id}`, {
      brief: "Ship it",
    });
    expect(brief.json().room.brief).toBe("Ship it");

    const edit = await call("PUT", `/api/rooms/${id}/members/codex`, {
      can_edit: true,
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().agents[1]).toMatchObject({
      id: "codex",
      can_edit: true,
    });

    const missing = await call("PUT", `/api/rooms/${id}/members/ghost`, {
      can_edit: false,
    });
    expect(missing.statusCode).toBe(403);
    const invalid = await call("PUT", `/api/rooms/${id}/members/codex`, {});
    expect(invalid.statusCode).toBe(400);
  });

  it("starts a break for one room or all rooms", async () => {
    const one = service.createRoom("one", "", ["claude"]);
    const two = service.createRoom("two", "", ["codex"]);
    const single = await call("POST", `/api/rooms/${one.id}/break`);
    expect(single.statusCode).toBe(200);
    expect(service.roomState(one.id).room.on_break).toBe(true);
    expect(service.roomState(two.id).room.on_break).toBe(false);

    const all = await call("POST", "/api/break-all");
    expect(all.statusCode).toBe(200);
    expect(service.roomState(two.id).room.on_break).toBe(true);
    const overview = (await call("GET", "/api/overview")).json();
    expect(overview.rooms.every((r: { on_break: boolean }) => r.on_break)).toBe(
      true,
    );
  });

  it("pages the complete permission history without crossing room boundaries", async () => {
    service.ensureAgent("worker", "Worker");
    const room = service.createRoom("history", "", ["worker"]);
    service.createRoom("other-history", "", ["worker"]);
    const session = service.join("worker", "history").session_id;
    const otherSession = service.join("worker", "other-history").session_id;
    for (let i = 0; i < 103; i += 1) {
      const item = service.requestPermission("worker", session, {
        recipient: "example.test",
        data_description: `item ${i}`,
        reason: "test",
      });
      service.decidePermission(item.id, i % 2 ? "approved" : "denied");
    }
    service.requestPermission("worker", otherSession, {
      recipient: "other.test",
      data_description: "other room",
      reason: "test",
    });
    const url = `/api/rooms/${room.id}/permissions`;
    expect(
      (await app.inject({ method: "GET", url, headers: { host: HOST } }))
        .statusCode,
    ).toBe(401);
    const first = (await call("GET", url)).json();
    expect(first.permissions).toHaveLength(50);
    const second = (
      await call("GET", `${url}?before_id=${first.next_before_id}`)
    ).json();
    expect(second.permissions).toHaveLength(50);
    const third = (
      await call("GET", `${url}?before_id=${second.next_before_id}`)
    ).json();
    expect(third.permissions).toHaveLength(3);
    expect(third.next_before_id).toBeNull();
    const all = [
      ...first.permissions,
      ...second.permissions,
      ...third.permissions,
    ] as { id: number; room_id: number }[];
    expect(new Set(all.map((item) => item.id)).size).toBe(103);
    expect(all.every((item) => item.room_id === room.id)).toBe(true);
    expect(all.map((item) => item.id)).toEqual(
      [...all.map((item) => item.id)].sort((a, b) => b - a),
    );
  });

  it("stores authenticated attachments, sends image-only messages and exposes local metadata", async () => {
    const room = service.createRoom("files", "", ["claude"]);
    const session = service.join("claude", "files").session_id;
    const uploadUrl = `/api/rooms/${room.id}/attachments?name=diagram.png`;
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
    ]);
    const denied = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { host: HOST, "content-type": "application/octet-stream" },
      payload: png,
    });
    expect(denied.statusCode).toBe(401);
    const upload = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: {
        host: HOST,
        cookie,
        "content-type": "application/octet-stream",
      },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json();
    expect(attachment.media_type).toBe("image/png");
    expect(attachment.path).toMatch(/\.png$/);
    expect(existsSync(attachment.path)).toBe(true);
    const downloadUrl = `/api/rooms/${room.id}/attachments/${attachment.id}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: downloadUrl,
          headers: { host: HOST },
        })
      ).statusCode,
    ).toBe(401);
    const download = await call("GET", downloadUrl);
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.rawPayload).toEqual(png);
    const inline = await call("GET", `${downloadUrl}?inline=1`);
    expect(inline.headers["content-disposition"]).toContain("inline;");
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/messages`, {
          body: "",
          attachment_ids: [attachment.id],
        })
      ).statusCode,
    ).toBe(200);
    const result = service.poll("claude", session, true);
    expect(result.status).toBe("turn");
    if (result.status !== "turn") throw new Error("Expected turn");
    expect(result.messages[0]?.attachments?.[0]).toMatchObject({
      path: attachment.path,
      filename: "diagram.png",
      size: png.length,
    });
    expect(
      (await call("GET", `/api/rooms/${room.id}/search?q=diagram`)).json()
        .messages[0].attachments[0].id,
    ).toBe(attachment.id);
    expect((await call("GET", `/api/rooms/${room.id}/export`)).body).toContain(
      "[diagram.png](file://",
    );
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/messages`, {
          body: "",
          attachment_ids: [attachment.id],
        })
      ).statusCode,
    ).toBe(400);
  });

  it("limits upload sizes and never serves SVG inline", async () => {
    const room = service.createRoom("safe-files", "", ["claude"]);
    const headers = {
      host: HOST,
      cookie,
      "content-type": "application/octet-stream",
    };
    const tooLarge = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/attachments?name=large`,
      headers,
      payload: Buffer.alloc(1025),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().message).toContain("size limit");
    const svg = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/attachments?name=picture.svg`,
      headers,
      payload: Buffer.from("<svg onload=alert(1) />"),
    });
    const attachment = svg.json();
    expect(attachment.media_type).toBe("application/octet-stream");
    expect(attachment.path).toMatch(/\.svg$/);
    const response = await call(
      "GET",
      `/api/rooms/${room.id}/attachments/${attachment.id}?inline=1`,
    );
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
      headers: { host: HOST, cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(existsSync(attachment.path)).toBe(false);
  });

  it("limits decision confirmation and revisions to the authenticated lead", async () => {
    const room = service.createRoom("decisions", "", ["claude"]);
    const joined = service.join("claude", "decisions");
    const proposed = service.proposeDecision(
      "claude",
      joined.session_id,
      "Deploy Monday",
      "one",
    );
    const url = `/api/rooms/${room.id}/decisions/${proposed.id}`;
    const unauthenticated = await app.inject({
      method: "POST",
      url,
      headers: { host: HOST },
      payload: { action: "confirm" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect((await call("POST", url, { action: "confirm" })).json().status).toBe(
      "confirmed",
    );
    expect(
      (
        await call("POST", url, { action: "revise", body: "Deploy Tuesday" })
      ).json().version,
    ).toBe(2);
    const versions = (await call("GET", `${url}/versions`)).json().versions;
    expect(versions.map((v: { body: string }) => v.body)).toEqual([
      "Deploy Tuesday",
      "Deploy Monday",
    ]);
    const other = service.createRoom("other", "", ["codex"]);
    expect(
      (
        await call("POST", `/api/rooms/${other.id}/decisions/${proposed.id}`, {
          action: "retire",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("shows and decides a room permission using the authenticated route", async () => {
    const room = service.createRoom("requests", "", ["claude"]);
    const joined = service.join("claude", "requests");
    const pending = service.requestPermission("claude", joined.session_id, {
      recipient: "example.com",
      data_description: "diagnostic",
      reason: "debug",
    });
    const state = (await call("GET", `/api/rooms/${room.id}`)).json();
    expect(state.permissions[0]).toMatchObject({
      id: pending.id,
      state: "pending",
      recipient: "example.com",
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/permissions/${pending.id}/decision`,
      headers: { host: HOST },
      payload: { decision: "approved" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(
      (
        await call("POST", `/api/permissions/${pending.id}/decision`, {
          decision: "approved",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call("GET", `/api/rooms/${room.id}`)).json().permissions[0],
    ).toMatchObject({ state: "approved", decided_by: "user" });
  });

  it("paginates room activity without leaking other rooms", async () => {
    const one = service.createRoom("first", "", ["claude"]);
    const two = service.createRoom("second", "", ["codex"]);
    for (let i = 0; i < 205; i += 1) service.setRoomPaused(one.id, i % 2 === 0);
    service.join("codex", "second");
    const first = await call("GET", `/api/rooms/${one.id}/activity`);
    expect(first.statusCode).toBe(200);
    const events = first.json().events as {
      id: number;
      agent_id: string | null;
    }[];
    expect(events).toHaveLength(200);
    expect(events.some((event) => event.agent_id === "codex")).toBe(false);
    const older = await call(
      "GET",
      `/api/rooms/${one.id}/activity?before_id=${events.at(-1)!.id}`,
    );
    expect(older.json().events.length).toBe(5);
    expect(
      (await call("GET", `/api/rooms/${two.id}/activity`)).json().events,
    ).toHaveLength(2);
  });

  it("searches and exports a room", async () => {
    const { id } = service.createRoom("notes", "A topic", ["claude"]);
    service.postUserMessage(id, "Find this 100% 👍🏽 🎉");
    service.postUserMessage(id, "Other text");

    const search = await call("GET", `/api/rooms/${id}/search?q=100%25`);
    expect(search.json().messages).toHaveLength(1);
    const emojiSearch = await call(
      "GET",
      `/api/rooms/${id}/search?q=${encodeURIComponent("👍🏽")}`,
    );
    expect(emojiSearch.json().messages[0].body).toBe("Find this 100% 👍🏽 🎉");
    const empty = await call("GET", `/api/rooms/${id}/search?q=%20`);
    expect(empty.statusCode).toBe(400);

    const exported = await call("GET", `/api/rooms/${id}/export`);
    expect(exported.headers["content-disposition"]).toContain("notes.md");
    expect(exported.body).toContain("# notes");
    expect(exported.body).toContain("Find this 100% 👍🏽 🎉");
  });

  it("extends the selected session and rejects unknown members", async () => {
    service.ensureAgent("worker", "Worker");
    const room = service.createRoom("run-window", "", ["worker"]);
    service.join("worker", "run-window");
    const url = `/api/rooms/${room.id}/members/worker/extend-run`;
    const before = service.roomState(room.id).agents[0]!.closes_at!;
    expect((await call("POST", url, { minutes: 60 })).statusCode).toBe(200);
    expect(service.roomState(room.id).agents[0]?.closes_at).toBe(
      before + 60 * 60_000,
    );
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/members/ghost/extend-run`, {
          minutes: 60,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call("POST", url, { minutes: 5000 })).statusCode).toBe(400);
  });

  it("keeps sign-in codes and credentials out of the logs", async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      service,
      port: PORT,
      logger: true,
      logStream: new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    });
    const code = service.createLoginCode();
    const login = await logged.inject({
      method: "GET",
      url: `/login?code=${code}`,
      headers: { host: HOST },
    });
    const sessionCookie =
      String(login.headers["set-cookie"]).split(";")[0] ?? "";
    await logged.inject({
      method: "GET",
      url: "/api/overview",
      headers: {
        host: HOST,
        cookie: sessionCookie,
        authorization: "Bearer secret-agent-token",
      },
    });
    await logged.close();

    const output = lines.join("");
    expect(output).toContain("/login");
    expect(output).not.toContain(code);
    expect(output).not.toContain("secret-agent-token");
    expect(output).not.toContain(sessionCookie.split("=")[1] ?? "missing");
  });

  it("pushes live updates over Server-Sent Events", async () => {
    await app.listen({ host: "127.0.0.1", port: PORT });
    const controller = new AbortController();
    const response = await fetch(`http://${HOST}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader?.read())?.value);
    expect(received).toContain("connected");

    service.createRoom("live", "", []);
    received = decoder.decode((await reader?.read())?.value);
    expect(received).toContain("data: change");
    controller.abort();
  });
});
