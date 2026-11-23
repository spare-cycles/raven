import type { Database } from "bun:sqlite";

/**
 * Ordered migrations; `PRAGMA user_version` is the count applied. Append only: an applied entry never changes.
 * `messages.id` is AUTOINCREMENT so an id is never reused, which the cursor contract depends on.
 * `to_json`/`cc_json` keep the recipients in the order given; `deliveries` is the routing and read state.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    created_ts TEXT NOT NULL
  );
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    program TEXT NOT NULL,
    model TEXT NOT NULL,
    task TEXT NOT NULL,
    created_ts TEXT NOT NULL,
    retired_ts TEXT,
    UNIQUE (project_id, name)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    sender_id INTEGER NOT NULL REFERENCES agents(id),
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    topic TEXT,
    importance TEXT NOT NULL,
    ack_required INTEGER NOT NULL,
    created_ts TEXT NOT NULL,
    idempotency_key TEXT
  );
  CREATE UNIQUE INDEX messages_idempotency ON messages (sender_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX messages_project ON messages (project_id, id);
  CREATE INDEX messages_topic ON messages (project_id, topic, id);
  CREATE INDEX messages_thread ON messages (thread_id, id);
  CREATE TABLE deliveries (
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    message_id INTEGER NOT NULL REFERENCES messages(id),
    kind TEXT NOT NULL CHECK (kind IN ('to', 'cc')),
    read_ts TEXT,
    ack_ts TEXT,
    PRIMARY KEY (agent_id, message_id)
  ) WITHOUT ROWID;
  `,
  // Bearer tokens: only the SHA-256 of a token is stored; `projects_json` is a key list or ["*"].
  `
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('agent', 'admin')),
    projects_json TEXT NOT NULL,
    created_ts TEXT NOT NULL,
    revoked_ts TEXT
  );
  `,
  // Full-text search over subject and body. Messages are never edited or deleted, so an insert trigger keeps it whole.
  `
  CREATE VIRTUAL TABLE messages_fts USING fts5(subject, body, content = 'messages', content_rowid = 'id');
  INSERT INTO messages_fts (rowid, subject, body) SELECT id, subject, body FROM messages;
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, subject, body) VALUES (new.id, new.subject, new.body);
  END;
  `,
  // Per-database settings: replacement name lists (`names.nouns`, `names.adjectives`).
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

/** Durability first: `send` promises the message is on disk when it resolves. */
export function migrate(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const applied = row?.user_version ?? 0;
  for (const [offset, sql] of MIGRATIONS.slice(applied).entries()) {
    db.transaction(() => {
      db.run(sql);
      db.run(`PRAGMA user_version = ${applied + offset + 1}`);
    })();
  }
}
