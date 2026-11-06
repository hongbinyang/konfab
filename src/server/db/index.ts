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
];

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
