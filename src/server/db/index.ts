import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE rooms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL DEFAULT '',
    archived_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    agent_streak INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    position INTEGER NOT NULL,
    last_seen_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, agent_id)
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    state TEXT NOT NULL CHECK (state IN ('active', 'replaced')),
    started_at INTEGER NOT NULL,
    last_call_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE UNIQUE INDEX one_active_session
    ON sessions(room_id, agent_id) WHERE state = 'active';

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent')),
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_by_room ON messages(room_id, id);

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    session_id TEXT REFERENCES sessions(id),
    reason TEXT NOT NULL CHECK (reason IN ('user', 'agent_mention')),
    state TEXT NOT NULL CHECK (
      state IN ('queued', 'active', 'completed', 'skipped', 'abandoned', 'dropped')
    ),
    last_message_id INTEGER,
    result_message_id INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE UNIQUE INDEX one_queued_turn
    ON turns(room_id, agent_id) WHERE state = 'queued';
  CREATE UNIQUE INDEX one_active_turn
    ON turns(room_id) WHERE state = 'active';

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    room_id INTEGER,
    agent_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_by_type ON events(type, agent_id, id);
  `,
  `
  CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    state TEXT NOT NULL CHECK (state IN ('active', 'replaced', 'ended')),
    end_reason TEXT,
    started_at INTEGER NOT NULL,
    last_call_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  INSERT INTO sessions_new (id, room_id, agent_id, state, started_at, last_call_at, ended_at)
    SELECT id, room_id, agent_id, state, started_at, last_call_at, ended_at FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_new RENAME TO sessions;
  CREATE UNIQUE INDEX one_active_session
    ON sessions(room_id, agent_id) WHERE state = 'active';

  CREATE TABLE permission_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    recipient TEXT NOT NULL,
    data_description TEXT NOT NULL,
    data_type TEXT,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied')),
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX permission_requests_by_state ON permission_requests(state, id);

  CREATE TABLE agent_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    kind TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    dismissed_at INTEGER
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE rooms ADD COLUMN on_break INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE rooms ADD COLUMN brief TEXT NOT NULL DEFAULT '';
  ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT '';
  ALTER TABLE room_members ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE sessions ADD COLUMN contact_lost_at INTEGER;
  ALTER TABLE turns ADD COLUMN first_started_at INTEGER;
  CREATE INDEX turns_by_room_agent_state ON turns(room_id, agent_id, state, id);
  CREATE INDEX permissions_by_room_agent_time ON permission_requests(room_id, agent_id, created_at);
  CREATE TABLE observed_waits (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    call_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    PRIMARY KEY (session_id, call_id)
  );
  CREATE INDEX events_by_room ON events(room_id, id);
  `,
  `
  ALTER TABLE permission_requests ADD COLUMN push_repository TEXT;
  ALTER TABLE permission_requests ADD COLUMN push_branch TEXT;
  ALTER TABLE permission_requests ADD COLUMN push_base TEXT;
  ALTER TABLE permission_requests ADD COLUMN push_head TEXT;
  CREATE INDEX permission_requests_by_room ON permission_requests(room_id, id);
  `,
  `
  ALTER TABLE room_members ADD COLUMN decision_seen_event_id INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE turns ADD COLUMN decision_snapshot_event_id INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    proposer TEXT NOT NULL,
    proposal_key TEXT UNIQUE,
    source_message_id INTEGER REFERENCES messages(id),
    status TEXT NOT NULL CHECK(status IN ('proposed','confirmed','rejected','retired')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX decisions_by_room ON decisions(room_id, id);
  CREATE TABLE decision_versions (
    decision_id INTEGER NOT NULL REFERENCES decisions(id),
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(decision_id, version)
  );
  `,
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    message_id INTEGER REFERENCES messages(id),
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_by_message ON attachments(message_id);
  `,
  `
  ALTER TABLE sessions ADD COLUMN run_ends_at INTEGER;
  `,
  `
  ALTER TABLE agents ADD COLUMN bridge_protocol INTEGER;
  CREATE TABLE bridge_receipts (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    request_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, request_key)
  );
  `,
  `
  ALTER TABLE sessions ADD COLUMN working_detail TEXT;
  ALTER TABLE sessions ADD COLUMN working_updated_at INTEGER;
  `,
  `
  ALTER TABLE sessions ADD COLUMN run_remaining_ms INTEGER;
  ALTER TABLE sessions ADD COLUMN run_break_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE room_members ADD COLUMN saved_run_ms INTEGER;
  CREATE TABLE run_warning_state (
    session_id TEXT NOT NULL REFERENCES sessions(id), threshold REAL NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0, cycle INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session_id, threshold)
  );
  CREATE TABLE run_warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    threshold REAL NOT NULL, cycle INTEGER NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(session_id, threshold, cycle)
  );
  `,
  `
  ALTER TABLE rooms ADD COLUMN lead_read_cursor INTEGER NOT NULL DEFAULT 0;
  UPDATE rooms SET lead_read_cursor = COALESCE((SELECT MAX(id) FROM messages WHERE room_id = rooms.id), 0);
  CREATE TABLE lead_seen_messages (
    room_id INTEGER NOT NULL REFERENCES rooms(id), message_id INTEGER NOT NULL REFERENCES messages(id),
    PRIMARY KEY(room_id, message_id)
  );
  CREATE INDEX messages_unread ON messages(room_id, sender_type, id);
  `,
  `
  ALTER TABLE turns ADD COLUMN post_result_json TEXT;
  ALTER TABLE turns ADD COLUMN repair_source_message_id INTEGER REFERENCES messages(id);
  CREATE TABLE handoffs (
    source_message_id INTEGER NOT NULL REFERENCES messages(id),
    target_agent_id TEXT NOT NULL REFERENCES agents(id),
    turn_id INTEGER NOT NULL REFERENCES turns(id),
    PRIMARY KEY(source_message_id, target_agent_id)
  );
  `,
  `
  ALTER TABLE rooms ADD COLUMN project_path TEXT;
  CREATE TABLE skill_libraries (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('personal','project')),
    root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  );
  CREATE TABLE skills (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES skill_libraries(id),
    folder_name TEXT NOT NULL, current_revision_id TEXT,
    created_at INTEGER NOT NULL, trashed_at INTEGER,
    UNIQUE(library_id, folder_name),
    FOREIGN KEY(id, current_revision_id) REFERENCES skill_revisions(skill_id, id)
      DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TABLE skill_revisions (
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id),
    number INTEGER NOT NULL, content_hash TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL, provenance_json TEXT NOT NULL DEFAULT '{}',
    licence TEXT, created_at INTEGER NOT NULL,
    restored_from_revision_id TEXT REFERENCES skill_revisions(id),
    UNIQUE(skill_id, number), UNIQUE(skill_id, id)
  );
  CREATE TABLE skill_blobs (hash TEXT PRIMARY KEY, content BLOB NOT NULL);
  CREATE TABLE skill_revision_files (
    revision_id TEXT NOT NULL REFERENCES skill_revisions(id), path TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES skill_blobs(hash), mode INTEGER NOT NULL,
    PRIMARY KEY(revision_id, path)
  );
  CREATE TABLE skill_reviews (
    revision_id TEXT PRIMARY KEY REFERENCES skill_revisions(id), reviewed_at INTEGER NOT NULL
  );
  CREATE TABLE skill_usages (
    skill_id TEXT NOT NULL, revision_id TEXT NOT NULL, owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL, label TEXT NOT NULL,
    PRIMARY KEY(skill_id, revision_id, owner_type, owner_id),
    FOREIGN KEY(skill_id, revision_id) REFERENCES skill_revisions(skill_id, id)
  );
  CREATE TABLE skill_temp_files (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES skill_libraries(id),
    content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE skill_rename_operations (
    skill_id TEXT PRIMARY KEY REFERENCES skills(id), old_name TEXT NOT NULL,
    new_name TEXT NOT NULL, old_hash TEXT NOT NULL, new_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','committed')),
    owns_destination INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN continuation_json TEXT;
  ALTER TABLE turns ADD COLUMN continuation_reason TEXT;
  ALTER TABLE turns ADD COLUMN continuation_source_message_id INTEGER REFERENCES messages(id);
  `,
  `
  ALTER TABLE turns ADD COLUMN last_progress_at INTEGER;
  ALTER TABLE turns ADD COLUMN timeout_retry_count INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE automatic_continuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES rooms(id),
    target_agent_id TEXT NOT NULL REFERENCES agents(id), source_turn_id INTEGER REFERENCES turns(id),
    source_message_id INTEGER REFERENCES messages(id), reason TEXT NOT NULL CHECK(reason IN ('timeout_recovery','watchdog')),
    due_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','fired','cancelled','capped')),
    created_at INTEGER NOT NULL, fired_at INTEGER,
    UNIQUE(source_turn_id, reason)
  );
  CREATE INDEX automatic_by_room_state ON automatic_continuations(room_id, state, due_at);
  `,
  `
  ALTER TABLE rooms ADD COLUMN auto_continue INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX one_pending_automatic_room ON automatic_continuations(room_id) WHERE state = 'pending';
  `,
  `
  CREATE TABLE skill_sources (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL COLLATE NOCASE, repository TEXT NOT NULL COLLATE NOCASE,
    ref TEXT NOT NULL, badge TEXT NOT NULL CHECK(badge IN ('vendor','community')),
    enabled INTEGER NOT NULL DEFAULT 1, current_generation_id TEXT,
    etag TEXT, last_checked_at INTEGER, rate_limit_reset INTEGER,
    UNIQUE(owner, repository, ref)
  );
  CREATE TABLE source_generations (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES skill_sources(id),
    commit_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('downloading','indexing','complete','failed')),
    discovered INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0,
    cache_bytes INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
    completed_at INTEGER, last_accessed_at INTEGER NOT NULL
  );
  CREATE TABLE source_entries (
    generation_id TEXT NOT NULL REFERENCES source_generations(id) ON DELETE CASCADE,
    path TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY(generation_id, path)
  );
  CREATE TABLE source_manifests (
    generation_id TEXT NOT NULL REFERENCES source_generations(id) ON DELETE CASCADE,
    path TEXT NOT NULL, content BLOB, name TEXT, description TEXT, licence TEXT,
    diagnostic TEXT, indexed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(generation_id, path)
  );
  CREATE INDEX source_generation_by_source ON source_generations(source_id, created_at);
  `,
  `
  CREATE TABLE skill_import_operations (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES skill_libraries(id),
    folder_name TEXT NOT NULL, staging_name TEXT NOT NULL,
    provenance_json TEXT NOT NULL, licence TEXT,
    state TEXT NOT NULL CHECK(state IN ('prepared','written','renamed')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE skill_import_drafts (
    id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES skill_libraries(id),
    folder_name TEXT NOT NULL, provenance_json TEXT NOT NULL, licence TEXT,
    diagnostic TEXT, revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE skill_import_draft_files (
    draft_id TEXT NOT NULL REFERENCES skill_import_drafts(id) ON DELETE CASCADE,
    path TEXT NOT NULL, content BLOB NOT NULL, mode INTEGER NOT NULL,
    PRIMARY KEY(draft_id, path)
  );
  CREATE TABLE source_cached_packages (
    generation_id TEXT NOT NULL REFERENCES source_generations(id) ON DELETE CASCADE,
    manifest_path TEXT NOT NULL, licence_path TEXT, cache_bytes INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, manifest_path)
  );
  CREATE TABLE source_cached_blobs (
    sha TEXT PRIMARY KEY, content BLOB NOT NULL
  );
  CREATE TABLE source_cached_files (
    generation_id TEXT NOT NULL, manifest_path TEXT NOT NULL, path TEXT NOT NULL,
    sha TEXT NOT NULL REFERENCES source_cached_blobs(sha), mode INTEGER NOT NULL,
    PRIMARY KEY(generation_id, manifest_path, path),
    FOREIGN KEY(generation_id, manifest_path) REFERENCES source_cached_packages(generation_id, manifest_path) ON DELETE CASCADE
  );
  `,
];

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  db.prepare("DELETE FROM bridge_receipts WHERE created_at < ?").run(
    Date.now() - 24 * 60 * 60 * 1000,
  );
  return db;
}

export function migrate(db: Db, target = MIGRATIONS.length): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= target) return;

  // Rebuilding a referenced table requires foreign keys to be off, and this
  // setting can only change outside a transaction.
  db.pragma("foreign_keys = OFF");
  try {
    for (let version = current; version < target; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) continue;
      db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(`Migration ${version + 1} broke foreign keys`);
        }
        db.pragma(`user_version = ${version + 1}`);
      })();
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
