import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Db } from "../db/index.js";
import { SkillError } from "./skill-error.js";
import { fileChunk } from "./file-chunk.js";
import { roleMetadata } from "./role-files.js";
import {
  packageHash,
  readSkillFiles,
  validSkillName,
  type SkillFile,
} from "./skill-files.js";

export class RoleLibrary {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.recoverWorkspaces();
  }

  private recoverWorkspaces(): void {
    const operations = this.db
      .prepare(
        `SELECT o.role_id, o.revision_id, o.previous_revision_id, r.folder_name, l.root_path
      FROM role_workspace_operations o JOIN roles r ON r.id = o.role_id JOIN role_libraries l ON l.id = r.library_id WHERE o.state = 'pending'`,
      )
      .all() as Array<{
      role_id: string;
      revision_id: string;
      previous_revision_id: string | null;
      folder_name: string;
      root_path: string;
    }>;
    for (const operation of operations) {
      try {
        if (!existsSync(operation.root_path))
          mkdirSync(operation.root_path, { recursive: true, mode: 0o700 });
        const root = lstatSync(operation.root_path);
        if (!root.isDirectory() || root.isSymbolicLink()) continue;
        const folder = join(operation.root_path, operation.folder_name);
        if (!existsSync(folder)) {
          mkdirSync(folder, { mode: 0o700 });
          writeFileSync(join(folder, ".konfab-role-owner"), operation.role_id, {
            flag: "wx",
            mode: 0o600,
          });
        }
        const folderStat = lstatSync(folder);
        if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) continue;
        const marker = join(folder, ".konfab-role-owner");
        if (!existsSync(marker)) continue;
        const markerStat = lstatSync(marker);
        if (
          !markerStat.isFile() ||
          markerStat.isSymbolicLink() ||
          markerStat.nlink !== 1 ||
          markerStat.size > 200 ||
          readFileSync(marker, "utf8") !== operation.role_id
        )
          continue;
        const previous = operation.previous_revision_id
          ? this.files(operation.previous_revision_id)
          : [];
        for (const file of this.files(operation.revision_id)) {
          const segments = file.path.split("/");
          let parent = folder;
          for (const segment of segments.slice(0, -1)) {
            parent = join(parent, segment);
            if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
            const stat = lstatSync(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink())
              throw new Error("Invalid workspace");
          }
          const target = join(parent, segments.at(-1)!);
          if (existsSync(target)) {
            const stat = lstatSync(target);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.nlink !== 1 ||
              stat.size > 512 * 1024
            )
              throw new Error("Workspace changed");
            const current = readFileSync(target);
            if (!current.equals(file.content)) {
              const prior = previous.find((item) => item.path === file.path);
              if (!prior || !current.equals(prior.content))
                throw new Error("Workspace changed");
              const temporary = join(
                parent,
                `.konfab-role-${operation.role_id}`,
              );
              if (existsSync(temporary)) {
                const temporaryStat = lstatSync(temporary);
                if (
                  !temporaryStat.isFile() ||
                  temporaryStat.isSymbolicLink() ||
                  temporaryStat.nlink !== 1 ||
                  temporaryStat.size > 512 * 1024 ||
                  !readFileSync(temporary).equals(file.content)
                )
                  throw new Error("Temporary file changed");
              } else
                writeFileSync(temporary, file.content, {
                  flag: "wx",
                  mode: file.mode & 0o777,
                });
              if (!readFileSync(target).equals(prior.content))
                throw new Error("Workspace changed");
              renameSync(temporary, target);
            }
          } else
            writeFileSync(target, file.content, {
              flag: "wx",
              mode: file.mode & 0o777,
            });
        }
        this.db
          .prepare(
            "UPDATE role_workspace_operations SET state = 'complete' WHERE role_id = ?",
          )
          .run(operation.role_id);
      } catch {
        /* Preserve changed or inaccessible workspaces for manual recovery. */
      }
    }
  }

  seedBuiltins(root: string): void {
    const library = "builtin";
    this.db
      .prepare(
        "INSERT OR IGNORE INTO role_libraries(id, kind, root_path) VALUES (?, 'builtin', ?)",
      )
      .run(library, root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const content = readFileSync(join(root, entry.name, "ROLE.md"));
      this.seedRole(library, entry.name, [
        { path: "ROLE.md", content, mode: 0o600 },
      ]);
    }
  }

  private seedRole(
    libraryId: string,
    folder: string,
    files: SkillFile[],
  ): void {
    const metadata = roleMetadata(files);
    if (metadata.name !== folder)
      throw new SkillError("invalid_role", 400, "Role name must match folder");
    const hash = this.roleHash(files, []);
    const roleId = `builtin:${folder}`;
    const current = this.db
      .prepare(
        `SELECT r.content_hash FROM roles o LEFT JOIN role_revisions r ON r.id = o.current_revision_id WHERE o.id = ?`,
      )
      .get(roleId) as { content_hash: string | null } | undefined;
    if (current?.content_hash === hash) return;
    const revision = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO roles(id, library_id, folder_name, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(roleId, libraryId, folder, this.now());
      const number =
        (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(number),0) AS n FROM role_revisions WHERE role_id = ?",
            )
            .get(roleId) as { n: number }
        ).n + 1;
      this.insertRevision(roleId, revision, number, files, [], metadata, hash);
      this.db
        .prepare("UPDATE roles SET current_revision_id = ? WHERE id = ?")
        .run(revision, roleId);
    })();
  }

  list(trash = false) {
    return this.db
      .prepare(
        `SELECT o.id, o.folder_name, o.library_id, r.id AS revision_id, r.number,
        r.name, r.title, r.description,
        (SELECT COUNT(*) FROM room_member_roles a WHERE a.role_id = o.id) AS usage_count
        FROM roles o JOIN role_revisions r ON r.id = o.current_revision_id
        WHERE (o.trashed_at IS NOT NULL) = ? ORDER BY o.library_id, r.title`,
      )
      .all(trash ? 1 : 0);
  }

  assignment(roomId: number, agentId: string) {
    const assignment = this.db
      .prepare(
        "SELECT role_id, role_revision_id, notes, revision FROM room_member_roles WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId) as Record<string, unknown> | undefined;
    const member = this.db
      .prepare(
        "SELECT role_assignment_revision FROM room_members WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId) as { role_assignment_revision: number } | undefined;
    if (!member) throw new SkillError("unavailable", 404, "Member unavailable");
    const canRevert = this.db
      .prepare(
        "SELECT 1 FROM converted_role_history WHERE room_id=? AND agent_id=? AND reverted_at IS NULL AND assignment_revision=? AND role_id=?",
      )
      .get(
        roomId,
        agentId,
        member.role_assignment_revision,
        assignment?.role_id ?? "",
      );
    return {
      ...(assignment ?? {}),
      revision: member.role_assignment_revision,
      assigned: !!assignment,
      can_revert: !!canRevert,
    };
  }

  customAssignments() {
    return this.db
      .prepare(
        `SELECT m.room_id, r.name AS room, m.agent_id, a.display_name,
      m.role AS text, m.role_assignment_revision AS revision
      FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id
      LEFT JOIN room_member_roles p ON p.room_id = m.room_id AND p.agent_id = m.agent_id
      WHERE r.archived_at IS NULL AND p.role_id IS NULL AND length(trim(m.role)) > 0
      ORDER BY r.name, m.position`,
      )
      .all();
  }

  convertCustom(
    groups: Array<{
      name: string;
      title: string;
      description: string;
      text: string;
      assign: boolean;
      members: Array<{ room_id: number; agent_id: string; revision: number }>;
    }>,
  ) {
    if (!groups.length || groups.length > 100)
      throw new SkillError("invalid_role", 400, "Choose roles to convert");
    const library = this.db
      .prepare("SELECT root_path FROM role_libraries WHERE id = 'personal'")
      .get() as { root_path: string } | undefined;
    if (!library)
      throw new SkillError("unavailable", 404, "Personal role library missing");
    const seenText = new Set<string>(),
      seenMembers = new Set<string>(),
      seenNames = new Set<string>();
    const result = this.db.transaction(() => {
      const converted: Array<{ id: string; revision_id: string }> = [];
      for (const group of groups) {
        if (
          !group.text.trim() ||
          seenText.has(group.text) ||
          !group.members.length ||
          group.members.length > 100
        )
          throw new SkillError(
            "invalid_role",
            400,
            "Invalid or duplicate conversion group",
          );
        seenText.add(group.text);
        if (!validSkillName(group.name))
          throw new SkillError("invalid_role", 400, "Enter a valid role name");
        if (
          seenNames.has(group.name) ||
          existsSync(join(library.root_path, group.name)) ||
          this.db
            .prepare(
              "SELECT 1 FROM roles WHERE library_id = 'personal' AND folder_name = ?",
            )
            .get(group.name)
        )
          throw new SkillError(
            "name_conflict",
            409,
            `Role name already exists: ${group.name}`,
          );
        seenNames.add(group.name);
        const content = Buffer.from(
          `---\nname: ${JSON.stringify(group.name)}\ntitle: ${JSON.stringify(group.title)}\ndescription: ${JSON.stringify(group.description)}\nskills: []\n---\n\n${group.text}`,
        );
        const files: SkillFile[] = [{ path: "ROLE.md", content, mode: 0o600 }];
        const metadata = roleMetadata(files);
        for (const member of group.members) {
          const key = `${member.room_id}:${member.agent_id}`;
          if (seenMembers.has(key))
            throw new SkillError(
              "invalid_role",
              400,
              "Member selected more than once",
            );
          seenMembers.add(key);
          const current = this.db
            .prepare(
              `SELECT m.role, m.role_assignment_revision, r.archived_at,
            (SELECT 1 FROM room_member_roles p WHERE p.room_id=m.room_id AND p.agent_id=m.agent_id) AS assigned
            FROM room_members m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=? AND m.agent_id=?`,
            )
            .get(member.room_id, member.agent_id) as
            | {
                role: string;
                role_assignment_revision: number;
                archived_at: number | null;
                assigned: number | null;
              }
            | undefined;
          if (
            !current ||
            current.archived_at !== null ||
            current.assigned ||
            current.role !== group.text ||
            current.role_assignment_revision !== member.revision
          )
            throw new SkillError(
              "role_conflict",
              409,
              "A selected assignment changed; refresh the preview",
            );
        }
        const id = randomUUID(),
          revision = randomUUID();
        this.db
          .prepare(
            "INSERT INTO roles(id,library_id,folder_name,created_at) VALUES (?,'personal',?,?)",
          )
          .run(id, group.name, this.now());
        this.insertRevision(
          id,
          revision,
          1,
          files,
          [],
          metadata,
          this.roleHash(files, []),
        );
        this.db
          .prepare("UPDATE roles SET current_revision_id=? WHERE id=?")
          .run(revision, id);
        this.db
          .prepare(
            "INSERT INTO role_workspace_operations(role_id,revision_id,state,created_at) VALUES (?,?,'pending',?)",
          )
          .run(id, revision, this.now());
        if (group.assign)
          for (const member of group.members) {
            this.assign(
              member.room_id,
              member.agent_id,
              id,
              revision,
              "",
              member.revision,
            );
            this.db
              .prepare(
                "INSERT INTO converted_role_history(id,room_id,agent_id,original_text,role_id,assignment_revision,created_at) VALUES (?,?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                member.room_id,
                member.agent_id,
                group.text,
                id,
                member.revision + 1,
                this.now(),
              );
          }
        converted.push({ id, revision_id: revision });
      }
      return converted;
    })();
    this.recoverWorkspaces();
    return {
      roles: result,
      pending: result
        .filter(
          (role) =>
            (
              this.db
                .prepare(
                  "SELECT state FROM role_workspace_operations WHERE role_id=?",
                )
                .get(role.id) as { state: string }
            ).state !== "complete",
        )
        .map((role) => role.id),
    };
  }

  revertConversion(roomId: number, agentId: string, baseRevision: number) {
    this.db.transaction(() => {
      const history = this.db
        .prepare(
          `SELECT * FROM converted_role_history WHERE room_id=? AND agent_id=? AND reverted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(roomId, agentId) as
        | {
            id: string;
            original_text: string;
            role_id: string;
            assignment_revision: number;
          }
        | undefined;
      const current = this.db
        .prepare(
          `SELECT m.role_assignment_revision, p.role_id FROM room_members m LEFT JOIN room_member_roles p ON p.room_id=m.room_id AND p.agent_id=m.agent_id WHERE m.room_id=? AND m.agent_id=?`,
        )
        .get(roomId, agentId) as
        | { role_assignment_revision: number; role_id: string | null }
        | undefined;
      if (
        !history ||
        !current ||
        current.role_id !== history.role_id ||
        current.role_assignment_revision !== baseRevision ||
        history.assignment_revision !== baseRevision
      )
        throw new SkillError(
          "role_conflict",
          409,
          "Assignment changed; cannot revert this conversion",
        );
      this.db
        .prepare("DELETE FROM room_member_roles WHERE room_id=? AND agent_id=?")
        .run(roomId, agentId);
      this.db
        .prepare(
          "UPDATE room_members SET role=?, role_assignment_revision=role_assignment_revision+1 WHERE room_id=? AND agent_id=?",
        )
        .run(history.original_text, roomId, agentId);
      this.db
        .prepare("UPDATE converted_role_history SET reverted_at=? WHERE id=?")
        .run(this.now(), history.id);
    })();
  }

  revisions(id: string) {
    return this.db
      .prepare(
        "SELECT id, number, name, title, description, created_at FROM role_revisions WHERE role_id = ? ORDER BY number DESC",
      )
      .all(id);
  }

  restoreRevision(
    id: string,
    targetRevision: string,
    baseRevision: string,
  ): string {
    const exists = this.db
      .prepare("SELECT 1 FROM role_revisions WHERE id = ? AND role_id = ?")
      .get(targetRevision, id);
    if (!exists)
      throw new SkillError("unavailable", 404, "Role revision unavailable");
    const oldPaths = this.files(baseRevision)
      .map((file) => file.path)
      .sort();
    const restoredPaths = this.files(targetRevision)
      .map((file) => file.path)
      .sort();
    if (JSON.stringify(oldPaths) !== JSON.stringify(restoredPaths))
      throw new SkillError(
        "role_conflict",
        409,
        "Restore requires manual reconciliation of role files",
      );
    const pins = this.pins(targetRevision) as Array<{
      skill_id: string;
      skill_revision_id: string;
    }>;
    return this.savePersonal(
      id,
      baseRevision,
      this.files(targetRevision),
      pins.map((pin) => ({
        skill_id: pin.skill_id,
        revision_id: pin.skill_revision_id,
      })),
    );
  }

  trash(id: string, baseRevision: string): void {
    this.db.transaction(() => {
      const role = this.db
        .prepare(
          "SELECT library_id, current_revision_id FROM roles WHERE id = ? AND trashed_at IS NULL",
        )
        .get(id) as
        { library_id: string; current_revision_id: string } | undefined;
      if (!role || role.library_id !== "personal")
        throw new SkillError(
          "forbidden",
          403,
          "Role is read-only or unavailable",
        );
      if (role.current_revision_id !== baseRevision)
        throw new SkillError("role_conflict", 409, "Role changed elsewhere");
      const uses = this.db
        .prepare(
          "SELECT room_id, agent_id FROM room_member_roles WHERE role_id = ?",
        )
        .all(id) as Array<{ room_id: number; agent_id: string }>;
      if (uses.length)
        throw new SkillError(
          "role_in_use",
          409,
          `Role in use: ${uses.map((use) => `room ${use.room_id} (${use.agent_id})`).join(", ")}`,
        );
      this.db
        .prepare("UPDATE roles SET trashed_at = ? WHERE id = ?")
        .run(this.now(), id);
    })();
  }

  restore(id: string, baseRevision: string): void {
    const result = this.db
      .prepare(
        "UPDATE roles SET trashed_at = NULL WHERE id = ? AND current_revision_id = ? AND library_id = 'personal' AND trashed_at IS NOT NULL",
      )
      .run(id, baseRevision);
    if (!result.changes)
      throw new SkillError("role_conflict", 409, "Role unavailable or changed");
  }

  detail(id: string) {
    const role = this.db
      .prepare(
        `SELECT o.id, o.library_id, o.folder_name, l.root_path, r.id AS revision_id, r.number,
        r.name, r.title, r.description,
        (SELECT state FROM role_workspace_operations w WHERE w.role_id = o.id) AS workspace_state
        FROM roles o JOIN role_libraries l ON l.id = o.library_id JOIN role_revisions r
        ON r.id = o.current_revision_id WHERE o.id = ? AND o.trashed_at IS NULL`,
      )
      .get(id);
    if (!role) throw new SkillError("unavailable", 404, "Role not found");
    const revision = (role as { revision_id: string }).revision_id;
    const manifest = this.files(revision).find(
      (file) => file.path === "ROLE.md",
    );
    let isDraft: boolean | null = null;
    if ((role as { library_id: string }).library_id === "personal") {
      try {
        const library = this.db
          .prepare("SELECT root_path FROM role_libraries WHERE id = 'personal'")
          .get() as { root_path: string };
        const current = readSkillFiles(
          join(
            library.root_path,
            (role as { folder_name: string }).folder_name,
          ),
        ).filter((file) => file.path !== ".konfab-role-owner");
        const saved = this.files(revision);
        isDraft =
          current.length !== saved.length ||
          saved.some(
            (file) =>
              !current.some(
                (item) =>
                  item.path === file.path && item.content.equals(file.content),
              ),
          );
      } catch {
        isDraft = null;
      }
    }
    return {
      ...role,
      role_md: manifest?.content.toString("utf8") ?? "",
      skills: this.pins(revision),
      is_draft: isDraft,
    };
  }

  duplicate(id: string, name: string): string {
    const source = this.db
      .prepare(
        "SELECT current_revision_id FROM roles WHERE id = ? AND trashed_at IS NULL",
      )
      .get(id) as { current_revision_id: string } | undefined;
    if (!source) throw new SkillError("unavailable", 404, "Role not found");
    const files = this.files(source.current_revision_id);
    const manifest = files.find((file) => file.path === "ROLE.md");
    if (!manifest) throw new SkillError("invalid_role", 400, "ROLE.md missing");
    const text = manifest.content.toString("utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new SkillError("invalid_role", 400, "Invalid ROLE.md");
    const document = parseDocument(match[1]!);
    document.set("name", name);
    const title = document.get("title");
    if (typeof title === "string") document.set("title", `${title} (copy)`);
    manifest.content = Buffer.from(
      `---\n${document.toString()}---\n${text.slice(match[0].length)}`,
    );
    const pins = this.pins(source.current_revision_id) as Array<{
      skill_id: string;
      skill_revision_id: string;
    }>;
    return this.createPersonal(
      "personal",
      name,
      files,
      pins.map((pin) => ({
        skill_id: pin.skill_id,
        revision_id: pin.skill_revision_id,
      })),
    );
  }

  savePersonal(
    id: string,
    baseRevision: string,
    files: SkillFile[],
    pins: Array<{ skill_id: string; revision_id: string }>,
  ): string {
    const role = this.db
      .prepare(
        "SELECT library_id, folder_name, current_revision_id FROM roles WHERE id = ? AND trashed_at IS NULL",
      )
      .get(id) as
      | { library_id: string; folder_name: string; current_revision_id: string }
      | undefined;
    if (!role || role.library_id !== "personal")
      throw new SkillError("forbidden", 403, "Role is read-only");
    if (role.current_revision_id !== baseRevision)
      throw new SkillError("role_conflict", 409, "Role changed elsewhere");
    const operation = this.db
      .prepare("SELECT state FROM role_workspace_operations WHERE role_id = ?")
      .get(id) as { state: string } | undefined;
    if (!operation || operation.state !== "complete")
      throw new SkillError("unavailable", 409, "Role workspace needs recovery");
    const library = this.db
      .prepare("SELECT root_path FROM role_libraries WHERE id = ?")
      .get(role.library_id) as { root_path: string };
    try {
      const workspace = readSkillFiles(
        join(library.root_path, role.folder_name),
      );
      if (
        workspace
          .find((file) => file.path === ".konfab-role-owner")
          ?.content.toString("utf8") !== id
      )
        throw new Error("invalid owner");
      const current = workspace.filter(
        (file) => file.path !== ".konfab-role-owner",
      );
      const previous = this.files(baseRevision);
      if (
        current.length !== previous.length ||
        previous.some(
          (prior) =>
            !current.some(
              (file) =>
                file.path === prior.path && file.content.equals(prior.content),
            ),
        )
      )
        throw new Error("changed");
    } catch {
      throw new SkillError(
        "role_conflict",
        409,
        "Role workspace changed elsewhere",
      );
    }
    const metadata = roleMetadata(files);
    if (metadata.name !== role.folder_name)
      throw new SkillError("invalid_role", 400, "Role name must match folder");
    const hash = this.roleHash(files, pins);
    const revision = randomUUID();
    this.db.transaction(() => {
      const number =
        (
          this.db
            .prepare("SELECT number FROM role_revisions WHERE id = ?")
            .get(baseRevision) as { number: number }
        ).number + 1;
      this.insertRevision(id, revision, number, files, pins, metadata, hash);
      const updated = this.db
        .prepare(
          "UPDATE roles SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?",
        )
        .run(revision, id, baseRevision);
      if (!updated.changes)
        throw new SkillError("role_conflict", 409, "Role changed elsewhere");
      this.db
        .prepare(
          "INSERT INTO role_workspace_operations(role_id, revision_id, previous_revision_id, state, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT(role_id) DO UPDATE SET revision_id = excluded.revision_id, previous_revision_id = excluded.previous_revision_id, state = 'pending', created_at = excluded.created_at",
        )
        .run(id, revision, baseRevision, this.now());
    })();
    this.recoverWorkspaces();
    if (
      (
        this.db
          .prepare(
            "SELECT state FROM role_workspace_operations WHERE role_id = ?",
          )
          .get(id) as { state: string }
      ).state !== "complete"
    )
      throw new SkillError(
        "workspace_pending",
        409,
        "Revision saved; role workspace needs recovery",
      );
    return revision;
  }

  saveManifest(
    id: string,
    baseRevision: string,
    manifest: string,
    pins: Array<{ skill_id: string; revision_id: string }>,
  ): string {
    const files = this.files(baseRevision).map((file) =>
      file.path === "ROLE.md"
        ? { ...file, content: Buffer.from(manifest) }
        : file,
    );
    return this.savePersonal(id, baseRevision, files, pins);
  }

  workingDraft(id: string) {
    const role = this.db
      .prepare(
        "SELECT o.folder_name, o.current_revision_id, l.root_path FROM roles o JOIN role_libraries l ON l.id = o.library_id WHERE o.id = ? AND l.kind = 'personal' AND o.trashed_at IS NULL",
      )
      .get(id) as
      | { folder_name: string; current_revision_id: string; root_path: string }
      | undefined;
    if (!role)
      throw new SkillError("unavailable", 404, "Role workspace unavailable");
    const workspace = readSkillFiles(join(role.root_path, role.folder_name));
    if (
      workspace
        .find((file) => file.path === ".konfab-role-owner")
        ?.content.toString("utf8") !== id
    )
      throw new SkillError(
        "unavailable",
        409,
        "Role workspace ownership changed",
      );
    const files = workspace.filter(
      (file) => file.path !== ".konfab-role-owner",
    );
    const manifest = files.find((file) => file.path === "ROLE.md");
    if (!manifest)
      throw new SkillError("invalid_role", 400, "ROLE.md is required");
    return {
      revision_id: role.current_revision_id,
      draft_hash: packageHash(files),
      manifest: manifest.content.toString("utf8"),
    };
  }

  saveWorkingDraft(
    id: string,
    baseRevision: string,
    draftHash: string,
    pins: Array<{ skill_id: string; revision_id: string }>,
  ): string {
    const role = this.db
      .prepare(
        "SELECT o.folder_name, o.current_revision_id, l.root_path FROM roles o JOIN role_libraries l ON l.id = o.library_id WHERE o.id = ? AND l.kind = 'personal' AND o.trashed_at IS NULL",
      )
      .get(id) as
      | { folder_name: string; current_revision_id: string; root_path: string }
      | undefined;
    if (!role || role.current_revision_id !== baseRevision)
      throw new SkillError("role_conflict", 409, "Role changed elsewhere");
    const operation = this.db
      .prepare("SELECT state FROM role_workspace_operations WHERE role_id = ?")
      .get(id) as { state: string } | undefined;
    if (!operation || operation.state !== "complete")
      throw new SkillError(
        "workspace_pending",
        409,
        "Role workspace needs recovery",
      );
    const folder = join(role.root_path, role.folder_name);
    const read = () => {
      const workspace = readSkillFiles(folder);
      if (
        workspace
          .find((file) => file.path === ".konfab-role-owner")
          ?.content.toString("utf8") !== id
      )
        throw new SkillError(
          "unavailable",
          409,
          "Role workspace ownership changed",
        );
      return workspace.filter((file) => file.path !== ".konfab-role-owner");
    };
    const files = read();
    if (packageHash(files) !== draftHash)
      throw new SkillError(
        "role_conflict",
        409,
        "Role workspace changed elsewhere",
      );
    const metadata = roleMetadata(files);
    if (metadata.name !== role.folder_name)
      throw new SkillError("invalid_role", 400, "Role name must match folder");
    const revision = randomUUID();
    this.db.transaction(() => {
      if (packageHash(read()) !== draftHash)
        throw new SkillError(
          "role_conflict",
          409,
          "Role workspace changed elsewhere",
        );
      const current = this.db
        .prepare("SELECT current_revision_id FROM roles WHERE id = ?")
        .get(id) as { current_revision_id: string };
      if (current.current_revision_id !== baseRevision)
        throw new SkillError("role_conflict", 409, "Role changed elsewhere");
      const number =
        (
          this.db
            .prepare("SELECT number FROM role_revisions WHERE id = ?")
            .get(baseRevision) as { number: number }
        ).number + 1;
      this.insertRevision(
        id,
        revision,
        number,
        files,
        pins,
        metadata,
        this.roleHash(files, pins),
      );
      this.db
        .prepare("UPDATE roles SET current_revision_id = ? WHERE id = ?")
        .run(revision, id);
      this.db
        .prepare(
          "UPDATE role_workspace_operations SET revision_id = ?, previous_revision_id = ?, state = 'complete' WHERE role_id = ?",
        )
        .run(revision, baseRevision, id);
    })();
    return revision;
  }

  createPersonal(
    libraryId: string,
    folder: string,
    files: SkillFile[],
    pins: Array<{ skill_id: string; revision_id: string }>,
  ): string {
    const library = this.db
      .prepare("SELECT kind, root_path FROM role_libraries WHERE id = ?")
      .get(libraryId) as { kind: string; root_path: string } | undefined;
    if (library?.kind !== "personal")
      throw new SkillError("unavailable", 404, "Personal role library missing");
    const metadata = roleMetadata(files);
    if (metadata.name !== folder)
      throw new SkillError("invalid_role", 400, "Role name must match folder");
    if (existsSync(join(library.root_path, folder)))
      throw new SkillError("name_conflict", 409, "Role folder already exists");
    if (
      this.db
        .prepare("SELECT 1 FROM roles WHERE library_id = ? AND folder_name = ?")
        .get(libraryId, folder)
    )
      throw new SkillError("name_conflict", 409, "Role name already exists");
    const id = randomUUID(),
      revision = randomUUID();
    const hash = this.roleHash(files, pins);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO roles(id, library_id, folder_name, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, libraryId, folder, this.now());
      this.insertRevision(id, revision, 1, files, pins, metadata, hash);
      this.db
        .prepare("UPDATE roles SET current_revision_id = ? WHERE id = ?")
        .run(revision, id);
      this.db
        .prepare(
          "INSERT INTO role_workspace_operations(role_id, revision_id, state, created_at) VALUES (?, ?, 'pending', ?)",
        )
        .run(id, revision, this.now());
    })();
    this.recoverWorkspaces();
    if (
      (
        this.db
          .prepare(
            "SELECT state FROM role_workspace_operations WHERE role_id = ?",
          )
          .get(id) as { state: string }
      ).state !== "complete"
    )
      throw new SkillError(
        "workspace_pending",
        409,
        "Role saved; workspace needs recovery",
      );
    return id;
  }

  assign(
    roomId: number,
    agentId: string,
    roleId: string,
    revisionId: string,
    notes: string,
    baseRevision?: number,
    canEdit?: boolean,
  ): void {
    this.db.transaction(() => {
      if ([...notes].length > 4000)
        throw new SkillError("role_limits", 413, "Room notes exceed limit");
      const role = this.db
        .prepare(
          "SELECT 1 FROM role_revisions r JOIN roles o ON o.id = r.role_id WHERE r.id = ? AND r.role_id = ? AND o.trashed_at IS NULL",
        )
        .get(revisionId, roleId);
      const member = this.db
        .prepare(
          "SELECT m.role_assignment_revision FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.room_id = ? AND m.agent_id = ? AND r.archived_at IS NULL",
        )
        .get(roomId, agentId) as
        { role_assignment_revision: number } | undefined;
      if (!role || !member)
        throw new SkillError("unavailable", 404, "Role or member unavailable");
      const unreviewed = this.db
        .prepare(
          `SELECT r.name FROM role_revision_skills p JOIN skill_revisions r ON r.id = p.skill_revision_id
        LEFT JOIN skill_reviews v ON v.revision_id = p.skill_revision_id
        WHERE p.role_revision_id = ? AND v.revision_id IS NULL`,
        )
        .all(revisionId) as { name: string }[];
      if (unreviewed.length)
        throw new SkillError(
          "skill_unreviewed",
          409,
          `Review before assignment: ${unreviewed.map((row) => row.name).join(", ")}`,
        );
      if (member.role_assignment_revision !== (baseRevision ?? 0))
        throw new SkillError("role_conflict", 409, "Role assignment changed");
      this.db
        .prepare(
          `INSERT INTO room_member_roles(room_id, agent_id, role_id, role_revision_id, notes, revision, generation, assigned_at)
        VALUES (?, ?, ?, ?, ?, 0, 1, ?) ON CONFLICT(room_id, agent_id) DO UPDATE SET
        role_id=excluded.role_id, role_revision_id=excluded.role_revision_id, notes=excluded.notes,
        revision=room_member_roles.revision+1, generation=room_member_roles.generation+1, assigned_at=excluded.assigned_at`,
        )
        .run(roomId, agentId, roleId, revisionId, notes, this.now());
      this.db
        .prepare(
          "UPDATE room_members SET role = '', can_edit = COALESCE(?, can_edit), role_assignment_revision = role_assignment_revision + 1 WHERE room_id = ? AND agent_id = ?",
        )
        .run(canEdit === undefined ? null : canEdit ? 1 : 0, roomId, agentId);
      this.envelope(roomId, agentId, false, true);
    })();
  }

  envelope(
    roomId: number,
    agentId: string,
    markDelivered: boolean,
    forceFull = false,
  ) {
    const assignment = this.db
      .prepare(
        `SELECT a.*, r.name, r.title, r.number FROM room_member_roles a JOIN role_revisions r
        ON r.id = a.role_revision_id WHERE a.room_id = ? AND a.agent_id = ?`,
      )
      .get(roomId, agentId) as Record<string, unknown> | undefined;
    if (!assignment) return null;
    const files = this.files(String(assignment.role_revision_id));
    const manifest = files.find((file) => file.path === "ROLE.md")!;
    const full =
      forceFull ||
      Number(assignment.delivered_generation) < Number(assignment.generation);
    const result = {
      id: assignment.role_id,
      revision_id: assignment.role_revision_id,
      name: assignment.name,
      number: assignment.number,
      changed: full,
      ...(full
        ? {
            title: assignment.title,
            notes: assignment.notes,
            role_md: manifest.content.toString("utf8"),
            skills: this.pins(String(assignment.role_revision_id)),
          }
        : {
            reminder:
              "Your pinned role remains active; call read_role to re-read it.",
          }),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
      throw new SkillError("role_limits", 413, "Role context exceeds 64 KiB");
    if (markDelivered && full)
      this.db
        .prepare(
          "UPDATE room_member_roles SET delivered_generation = generation WHERE room_id = ? AND agent_id = ? AND generation = ?",
        )
        .run(roomId, agentId, assignment.generation);
    return result;
  }

  readFile(revisionId: string, path: string, offset = 0, max = 32 * 1024) {
    if (offset < 0 || max < 1 || max > 128 * 1024)
      throw new SkillError("invalid_path", 400, "Invalid read range");
    const file = this.files(revisionId).find((item) => item.path === path);
    if (!file)
      throw new SkillError("unavailable", 404, "Role file unavailable");
    return fileChunk(file.content, offset, max);
  }

  private pins(revisionId: string) {
    return this.db
      .prepare(
        `SELECT p.position, p.skill_id, p.skill_revision_id, r.name, r.description,
        CASE WHEN v.revision_id IS NULL THEN 0 ELSE 1 END AS reviewed
        FROM role_revision_skills p JOIN skill_revisions r ON r.id = p.skill_revision_id
        LEFT JOIN skill_reviews v ON v.revision_id = p.skill_revision_id
        WHERE p.role_revision_id = ? ORDER BY p.position`,
      )
      .all(revisionId)
      .map((row) => {
        const pin = row as { skill_id: string; skill_revision_id: string };
        return {
          ...pin,
          files: this.db
            .prepare(
              "SELECT path FROM skill_revision_files WHERE revision_id = ? ORDER BY path",
            )
            .all(pin.skill_revision_id),
        };
      });
  }

  private files(revisionId: string): SkillFile[] {
    return this.db
      .prepare(
        `SELECT f.path, f.mode, b.content FROM role_revision_files f JOIN skill_blobs b
        ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path`,
      )
      .all(revisionId) as SkillFile[];
  }

  private roleHash(
    files: SkillFile[],
    pins: Array<{ skill_id: string; revision_id: string }>,
  ): string {
    const hash = createHash("sha256");
    hash.update(packageHash(files));
    for (const pin of pins)
      hash.update(pin.skill_id).update("\0").update(pin.revision_id);
    return hash.digest("hex");
  }

  private insertRevision(
    roleId: string,
    revision: string,
    number: number,
    files: SkillFile[],
    pins: Array<{ skill_id: string; revision_id: string }>,
    metadata: { name: string; title: string; description: string },
    hash: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO role_revisions(id, role_id, number, content_hash, name, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        revision,
        roleId,
        number,
        hash,
        metadata.name,
        metadata.title,
        metadata.description,
        this.now(),
      );
    const blob = this.db.prepare(
      "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
    );
    const fileRef = this.db.prepare(
      "INSERT INTO role_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
    );
    for (const file of files) {
      const blobHash = createHash("sha256").update(file.content).digest("hex");
      blob.run(blobHash, file.content);
      fileRef.run(revision, file.path, blobHash, file.mode);
    }
    const pinRef = this.db.prepare(
      "INSERT INTO role_revision_skills(role_revision_id, position, skill_id, skill_revision_id) VALUES (?, ?, ?, ?)",
    );
    const usage = this.db.prepare(
      "INSERT INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES (?, ?, 'role_revision', ?, ?)",
    );
    for (const [position, pin] of pins.entries()) {
      pinRef.run(revision, position, pin.skill_id, pin.revision_id);
      usage.run(
        pin.skill_id,
        pin.revision_id,
        revision,
        `Role ${metadata.title} rev ${number}`,
      );
    }
  }
}
