import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import {
  generateToken,
  KonfabService,
} from "../../src/server/domain/service.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import { createBridgeServer as createOldBridge } from "../fixtures/old-bridge/tools.js";
import { buildOldDatabase, ID } from "../fixtures/old-database.js";

const PORT = 18794;

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };

/**
 * A conversation that joined before the upgrade keeps its connector, and so
 * the bridge and tool list it had then. It must keep working unchanged and
 * reach a new assignment with only those tools.
 */
describe("a connector started before roles became skills", () => {
  let dir: string;
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as ToolResult;
    if (result.isError) throw new Error(result.content[0]?.text);
    return JSON.parse(result.content[0]?.text ?? "null") as Record<
      string,
      unknown
    >;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "konfab-old-bridge-"));
    const fixture = buildOldDatabase(dir);
    db = openDatabase(fixture.path);
    new SkillLibrary(db).seedBuiltins("src/server/skills/builtin");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 3_600_000,
      maxMessageChars: 10_000,
    });
    const token = generateToken();
    service.setAgentToken("claude", token);
    app = await buildApp({ service, port: PORT });
    await app.listen({ host: "127.0.0.1", port: PORT });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createOldBridge({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token,
    }).connect(serverTransport);
    client = new Client({ name: "old", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replays its turn exactly and reaches a later assignment through the old tools alone", async () => {
    const golden = JSON.parse(
      readFileSync("tests/fixtures/old-role-replies.json", "utf8"),
    ) as Record<string, unknown>;
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("read_role");
    expect(tools).not.toContain("read_assignment");

    // The turn in progress during the upgrade.
    const replay = await call("wait_for_turn", { session_id: "s-claude" });
    expect(replay.status).toBe("turn");
    expect(JSON.stringify(replay.role)).toBe(
      JSON.stringify(golden.wait_active_role),
    );
    expect(
      JSON.stringify(await call("read_role", { session_id: "s-claude" })),
    ).toBe(JSON.stringify(golden.read_role_active));
    const roleFile = await call("read_role_file", {
      session_id: "s-claude",
      role_revision_id: ID["dev-1"],
      path: "ROLE.md",
    });
    expect(JSON.stringify(roleFile)).toBe(
      JSON.stringify(golden.read_role_file_active),
    );
    await call("pass_turn", {
      session_id: "s-claude",
      turn_id: replay.turn_id,
    });

    // The lead changes the assignment: a different order, a built-in skill sent as a summary.
    const current = service.memberAssignment(1, "claude");
    const qa = db
      .prepare(
        "SELECT id, current_revision_id FROM skills WHERE library_id = 'builtin' AND folder_name = 'qa'",
      )
      .get() as { id: string; current_revision_id: string };
    service.setAssignment(1, "claude", {
      base_revision: current.revision,
      instructions: "Work in your own worktree.",
      pins: [
        {
          skill_id: qa.id,
          revision_id: qa.current_revision_id,
          delivery: "summary",
        },
        ...current.skills.map((skill) => ({
          skill_id: skill.skill_id,
          revision_id: skill.revision_id,
          delivery: skill.delivery,
        })),
      ],
    });
    service.postUserMessage(1, "@claude go");
    const changed = await call("wait_for_turn", { session_id: "s-claude" });
    expect(changed.role).toMatchObject({
      changed: true,
      notice: expect.stringContaining("read_role"),
    });
    const assignment = changed.assignment as {
      instructions: string;
      skills: Array<{
        revision_id: string;
        name: string;
        delivery: string;
        files: string[];
      }>;
    };
    expect(assignment.instructions).toBe("Work in your own worktree.");
    expect(assignment.skills.map((skill) => skill.name)).toEqual([
      "qa",
      "konfab-dev-role",
      "helper",
    ]);
    // read_role returns the same assignment, and read_skill_file reaches every file,
    // including the full text of skills sent as summaries.
    // The same content, without the one-time notice of the turn.
    const { notice, ...content } = assignment as typeof assignment & {
      notice?: string;
    };
    expect(notice).toContain("Your skills changed");
    expect(
      (await call("read_role", { session_id: "s-claude" })).assignment,
    ).toEqual(content);
    for (const skill of assignment.skills)
      for (const path of skill.files) {
        const file = await call("read_skill_file", {
          session_id: "s-claude",
          skill_revision_id: skill.revision_id,
          path,
        });
        expect(file.total_size).toBeGreaterThan(0);
      }
    const qaText = await call("read_skill_file", {
      session_id: "s-claude",
      skill_revision_id: qa.current_revision_id,
      path: "SKILL.md",
    });
    expect(qaText.content).toContain("name: qa");
  });
});
