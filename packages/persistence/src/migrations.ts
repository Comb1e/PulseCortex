import type Database from "better-sqlite3";

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE owner_binding (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        paired_at INTEGER NOT NULL
      );
      CREATE TABLE pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        canonical_path TEXT NOT NULL,
        path_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_turn_id TEXT,
        state TEXT NOT NULL,
        bot_created INTEGER NOT NULL CHECK (bot_created IN (0, 1))
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        safe_summary TEXT NOT NULL DEFAULT '',
        diff_text TEXT NOT NULL DEFAULT '',
        changed_file_count INTEGER NOT NULL DEFAULT 0,
        test_summary TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE pending_interactions (
        nonce TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX pending_interactions_request ON pending_interactions(request_id, consumed_at);
      CREATE TABLE processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE delivery_queue (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX delivery_queue_pending ON delivery_queue(delivered_at, next_attempt_at);
      CREATE TABLE milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        tenant_id TEXT,
        user_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        summary TEXT NOT NULL,
        data_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX audit_log_created ON audit_log(created_at);
    `,
  },
  {
    version: 2,
    sql: `ALTER TABLE owner_binding ADD COLUMN chat_id TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 3,
    sql: `ALTER TABLE pairing_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE delivery_queue ADD COLUMN dedupe_key TEXT;
      CREATE UNIQUE INDEX delivery_queue_dedupe_pending ON delivery_queue(dedupe_key) WHERE delivered_at IS NULL AND dedupe_key IS NOT NULL;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE local_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version),
  );
  const apply = database.transaction((migration: { version: number; sql: string }) => {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
  });
  for (const migration of MIGRATIONS) if (!applied.has(migration.version)) apply(migration);
}

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
