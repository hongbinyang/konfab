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
];

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
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
