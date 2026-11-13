import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import {
  ASSIGNMENT_LIMIT_BYTES,
  NOTICE_LIMIT_BYTES,
  PRECEDENCE,
  assignmentBytes,
  clipNotice,
  envelopeBytes,
} from "../../src/server/domain/assignments.js";

type Delivery = "full" | "summary";

describe("skill assignments", () => {
  let dir: string;
  let db: Db;
  let service: KonfabService;
  let skills: SkillLibrary;
  let libraryId: string;
  let claude: string;
  let codex: string;

  const turn = (agent: "claude" | "codex") => {
    const result = service.poll(
      agent,
      agent === "claude" ? claude : codex,
      true,
    );
    if (result.status !== "turn")
      throw new Error(`expected a turn: ${result.status}`);
    return result;
  };
  const builtin = (name: string, delivery: Delivery = "full") => {
    const row = db
      .prepare(
        "SELECT id, current_revision_id FROM skills WHERE library_id = 'builtin' AND folder_name = ?",
      )
      .get(name) as { id: string; current_revision_id: string };
    return { skill_id: row.id, revision_id: row.current_revision_id, delivery };
  };
  const assign = (
    agent: string,
    pins: Array<{ skill_id: string; revision_id: string; delivery: Delivery }>,
    instructions = "",
    review: string[] = [],
  ) =>
    service.setAssignment("room", agent, {
      base_revision: service.memberAssignment("room", agent).revision,
      instructions,
      pins,
      review,
    });
  /** A local skill with a SKILL.md body of the given size; returns its saved revision. */
  const localSkill = (name: string, bodyBytes: number, body = "x") => {
    const id = skills.create(libraryId, name, `${name} skill`);
    const detail = skills.detail(id);
    skills.writeFile(
      id,
      "SKILL.md",
      Buffer.from(
        `---\nname: ${name}\ndescription: ${name} skill\n---\n${body.repeat(Math.ceil(bodyBytes / body.length)).slice(0, bodyBytes)}`,
      ),
      detail.current_revision_id,
      detail.draft_hash!,
    );
    const revision = skills.save(
      id,
      detail.current_revision_id,
      skills.detail(id).draft_hash!,
    );
    return {
      skill_id: id,
      revision_id: revision,
      delivery: "full" as Delivery,
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konfab-assign-"));
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 3_600_000,
      maxMessageChars: 10_000,
    });
    skills = new SkillLibrary(db);
    skills.seedBuiltins("src/server/skills/builtin");
    mkdirSync(join(dir, "skills"));
    libraryId = skills.registerLibrary("personal", join(dir, "skills"));
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom("room", "", ["claude", "codex"]);
    claude = service.join("claude", "room").session_id;
    codex = service.join("codex", "room").session_id;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers skills in order with the precedence rule, then only a reminder", () => {
    assign(
      "claude",
      [builtin("reviewer"), builtin("qa", "summary")],
      "Work in your own worktree.",
    );
    service.postUserMessage("room", "@claude go");
    const first = turn("claude");
    expect(first.assignment).toMatchObject({
      changed: true,
      precedence: PRECEDENCE,
      instructions: "Work in your own worktree.",
      skills: [
        expect.objectContaining({
          position: 1,
          name: "reviewer",
          skill_md: expect.stringContaining("# Reviewer"),
        }),
        expect.objectContaining({
          position: 2,
          name: "qa",
          delivery: "summary",
          read_first: expect.any(String),
        }),
      ],
    });
    expect(
      (first.assignment as { skills: Array<{ skill_md?: string }> }).skills[1]!
        .skill_md,
    ).toBeUndefined();
    // Replays of the same turn are identical.
    expect(turn("claude").assignment).toEqual(first.assignment);
    service.passTurn("claude", claude, first.turn_id);
    service.postUserMessage("room", "@claude again");
    expect(turn("claude").assignment).toMatchObject({
      changed: false,
      reminder: expect.any(String),
    });
  });

  it("describes added, updated, reordered and removed skills and instruction-only changes", () => {
    const next = () => {
      service.postUserMessage("room", "@claude go");
      const result = turn("claude");
      service.passTurn("claude", claude, result.turn_id);
      return (result.assignment as { notice?: string } | null)?.notice ?? null;
    };
    assign("claude", [builtin("reviewer")]);
    expect(next()).toContain("You have been given an assignment");
    assign("claude", [builtin("reviewer")], "New notes");
    expect(next()).toContain("Your room instructions changed");
    assign("claude", [builtin("reviewer"), builtin("qa")], "New notes");
    expect(next()).toContain("added qa rev 1");
    assign("claude", [builtin("qa"), builtin("reviewer")], "New notes");
    expect(next()).toContain("reordered");
    const v2 = localSkill("planner", 10);
    assign("claude", [builtin("qa"), v2], "New notes", [v2.revision_id]);
    expect(next()).toMatch(/added planner rev 2; removed reviewer rev 1/);
    assign("claude", [], "");
    service.postUserMessage("room", "@claude go");
    const removed = turn("claude");
    expect(removed.role).toMatchObject({ removed: true });
    expect(removed.assignment).toMatchObject({
      notice: expect.stringContaining("was removed"),
    });
  });

  it("keeps a delivered assignment within the limit, whatever the change notice says", () => {
    const deliver = () => {
      service.postUserMessage("room", "@claude go");
      const result = turn("claude");
      service.passTurn("claude", claude, result.turn_id);
      return result.assignment as { notice?: string };
    };
    // A skill sized so the assignment, with 6,000 characters of instructions, sits just under 64 KiB.
    const probe = localSkill("edge-a", 1);
    const base = assignmentBytes(db, "a".repeat(6000), [probe]);
    const edge = localSkill("edge-b", ASSIGNMENT_LIMIT_BYTES - base - 32);
    assign("claude", [edge], "a".repeat(6000), [edge.revision_id]);
    expect(assignmentBytes(db, "a".repeat(6000), [edge])).toBeLessThanOrEqual(
      ASSIGNMENT_LIMIT_BYTES,
    );
    expect(assignmentBytes(db, "a".repeat(6000), [edge])).toBeGreaterThan(
      ASSIGNMENT_LIMIT_BYTES - 128,
    );
    deliver();
    // An instruction-only change with the longest instructions.
    assign("claude", [edge], "b".repeat(6000));
    const changed = deliver();
    expect(changed.notice).toContain("room instructions changed");
    expect(envelopeBytes(changed)).toBeLessThanOrEqual(ASSIGNMENT_LIMIT_BYTES);
    // Many skills with long names replaced at once.
    const many = (prefix: string) =>
      Array.from({ length: 12 }, (_, index) =>
        localSkill(`${prefix}-${index}-${"n".repeat(50)}`.slice(0, 64), 10),
      );
    const first = many("first");
    assign(
      "claude",
      first,
      "i".repeat(6000),
      first.map((p) => p.revision_id),
    );
    deliver();
    const second = many("second");
    assign(
      "claude",
      second,
      "j".repeat(6000),
      second.map((p) => p.revision_id),
    );
    const replaced = deliver();
    expect(replaced.notice).toContain("and 7 more");
    expect(envelopeBytes(replaced.notice)).toBeLessThanOrEqual(
      NOTICE_LIMIT_BYTES,
    );
    expect(envelopeBytes(replaced)).toBeLessThanOrEqual(ASSIGNMENT_LIMIT_BYTES);
    expect(clipNotice("é".repeat(5000)).endsWith("…")).toBe(true);
    expect(envelopeBytes(clipNotice("é\n".repeat(5000)))).toBeLessThanOrEqual(
      NOTICE_LIMIT_BYTES,
    );
  });

  it("keeps an active turn on its assignment until the next turn", () => {
    const helper = localSkill("helper", 10);
    assign("claude", [helper], "", [helper.revision_id]);
    service.postUserMessage("room", "@claude go");
    const active = turn("claude");
    assign("claude", [builtin("qa")], "Changed");
    // The active turn still reads its own skill and not the new one.
    expect(service.readAssignment("claude", claude)).toMatchObject({
      skills: [expect.objectContaining({ name: "helper" })],
    });
    expect(
      service.readAssignedSkillFile(
        "claude",
        claude,
        helper.revision_id,
        "SKILL.md",
        0,
        1024,
      ),
    ).toBeTruthy();
    expect(() =>
      service.readAssignedSkillFile(
        "claude",
        claude,
        builtin("qa").revision_id,
        "SKILL.md",
        0,
        1024,
      ),
    ).toThrow(/not assigned/);
    expect(JSON.stringify(turn("claude"))).not.toContain("Changed");
    service.passTurn("claude", claude, active.turn_id);
    service.postUserMessage("room", "@claude next");
    expect(turn("claude").assignment).toMatchObject({
      instructions: "Changed",
      notice: expect.stringContaining("removed helper rev 2"),
    });
  });

  it("rejects an oversized assignment on every path before writing anything", () => {
    const long = localSkill("long", 70 * 1024);
    const summary = { ...long, delivery: "summary" as Delivery };
    expect(() => assign("claude", [long], "", [long.revision_id])).toThrow(
      /64 KiB/,
    );
    expect(service.memberAssignment("room", "claude").revision).toBe(0);
    // As a summary it fits.
    assign("claude", [summary], "", [long.revision_id]);
    // Team: moving a summary bundle fits; assigning the full text does not.
    const codexRev = service.memberAssignment("room", "codex").revision;
    expect(() =>
      service.reassignAssignments("room", [
        { agent_id: "codex", pins: [long], base_revision: codexRev },
      ]),
    ).toThrow(/64 KiB/);
    expect(service.memberAssignment("room", "codex").skills).toEqual([]);
    // Updating members to a newer revision that no longer fits.
    const detail = skills.detail(long.skill_id);
    skills.writeFile(
      long.skill_id,
      "SKILL.md",
      Buffer.from(`---\nname: long\ndescription: long skill\n---\nshort`),
      detail.current_revision_id,
      detail.draft_hash!,
    );
    const short = skills.save(
      long.skill_id,
      detail.current_revision_id,
      skills.detail(long.skill_id).draft_hash!,
    );
    const claudeRev = service.memberAssignment("room", "claude").revision;
    service.updateSkillAssignments(
      long.skill_id,
      short,
      [{ room_id: 1, agent_id: "claude", base_revision: claudeRev }],
      true,
    );
    expect(service.memberAssignment("room", "claude").skills[0]).toMatchObject({
      revision_id: short,
    });
    // Long room instructions together with a full skill.
    expect(() =>
      assign(
        "claude",
        [{ ...long, revision_id: short }, localSkill("medium", 60 * 1024)],
        "i".repeat(6000),
        [short],
      ),
    ).toThrow();
  });

  it("swaps and rotates whole bundles; edit permission and names stay with each member", () => {
    service.setMemberEdit("room", "codex", true);
    assign("claude", [builtin("implementer")], "Implement");
    assign("codex", [builtin("reviewer")], "Review");
    const rev = (agent: string) =>
      service.memberAssignment("room", agent).revision;
    expect(() =>
      service.reassignAssignments("room", [
        {
          agent_id: "claude",
          from_agent_id: "codex",
          base_revision: rev("claude") + 1,
        },
        {
          agent_id: "codex",
          from_agent_id: "claude",
          base_revision: rev("codex"),
        },
      ]),
    ).toThrow(/changed since the preview/);
    expect(service.memberAssignment("room", "claude").instructions).toBe(
      "Implement",
    );
    service.reassignAssignments("room", [
      {
        agent_id: "claude",
        from_agent_id: "codex",
        base_revision: rev("claude"),
      },
      {
        agent_id: "codex",
        from_agent_id: "claude",
        base_revision: rev("codex"),
      },
    ]);
    const state = service.roomState("room");
    expect(state.agents.find((a) => a.id === "claude")).toMatchObject({
      can_edit: false,
      assignment: { label: "reviewer rev 1", instructions: "Review" },
    });
    expect(state.agents.find((a) => a.id === "codex")).toMatchObject({
      can_edit: true,
      assignment: { label: "implementer rev 1", instructions: "Implement" },
    });
    expect(state.messages.at(-1)?.body).toContain("Skills reassigned by lead");
    service.reassignAssignments("room", [
      { agent_id: "claude", none: true, base_revision: rev("claude") },
    ]);
    expect(service.memberAssignment("room", "claude")).toMatchObject({
      instructions: "",
      skills: [],
    });
  });

  it("refuses a cross-room update that includes an archived room, changing nothing", () => {
    const helper = localSkill("helper", 10);
    service.createRoom("old", "", ["claude"]);
    for (const room of ["room", "old"])
      service.setAssignment(room, "claude", {
        base_revision: 0,
        instructions: "",
        pins: [helper],
        review: [helper.revision_id],
      });
    service.archiveRoom("old");
    const detail = skills.detail(helper.skill_id);
    skills.writeFile(
      helper.skill_id,
      "SKILL.md",
      Buffer.from("---\nname: helper\ndescription: helper skill\n---\nv3"),
      detail.current_revision_id,
      detail.draft_hash!,
    );
    const next = skills.save(
      helper.skill_id,
      detail.current_revision_id,
      skills.detail(helper.skill_id).draft_hash!,
    );
    const targets = (
      service.skillUsages(helper.skill_id) as Array<{
        room_id: number;
        agent_id: string;
        base_revision: number;
      }>
    ).map(({ room_id, agent_id, base_revision }) => ({
      room_id,
      agent_id,
      base_revision,
    }));
    expect(targets).toHaveLength(2);
    expect(() =>
      service.updateSkillAssignments(helper.skill_id, next, targets, true),
    ).toThrow(/archived/);
    for (const room of ["room", "old"])
      expect(service.memberAssignment(room, "claude").skills[0]).toMatchObject({
        revision_id: helper.revision_id,
      });
    const active = targets.filter((target) => target.room_id === 1);
    service.updateSkillAssignments(helper.skill_id, next, active, true);
    expect(service.memberAssignment("room", "claude").skills[0]).toMatchObject({
      revision_id: next,
    });
    expect(service.memberAssignment("old", "claude").skills[0]).toMatchObject({
      revision_id: helper.revision_id,
    });
  });

  it("protects assigned skills from trash and keeps built-in skills read-only", () => {
    const helper = localSkill("helper", 10);
    assign("claude", [helper], "", [helper.revision_id]);
    const draft = () => skills.detail(helper.skill_id).draft_hash!;
    expect(() =>
      skills.trash(helper.skill_id, helper.revision_id, draft()),
    ).toThrow(/in use: Room room/);
    assign("claude", []);
    skills.trash(helper.skill_id, helper.revision_id, draft());
    expect(() => assign("claude", [helper])).toThrow(/unavailable/);
    const reviewer = builtin("reviewer");
    expect(() =>
      skills.trash(reviewer.skill_id, reviewer.revision_id, "x"),
    ).toThrow(/read-only/);
    // Seeding again with unchanged files adds no revision.
    skills.seedBuiltins("src/server/skills/builtin");
    expect(builtin("reviewer").revision_id).toBe(reviewer.revision_id);
  });

  it("lets read_role reach a new assignment for conversations with the old tool list", () => {
    assign("claude", [builtin("reviewer")], "Notes");
    const reply = service.readAssignedRole("claude", claude);
    expect(reply.role).toMatchObject({
      changed: true,
      notice: expect.stringContaining("read_role"),
    });
    expect(reply.assignment).toMatchObject({ instructions: "Notes" });
    expect(service.join("claude", "room")).toMatchObject({
      assignment: { instructions: "Notes" },
    });
  });
});
