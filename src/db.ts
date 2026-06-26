// SQLite layer: open in WAL mode, run migrations, seed accounts with an idempotent upsert.
//
// WAL + a busy_timeout is what lets MANY independent server processes (one per agent session)
// safely share one database file: writers serialize, readers don't block, and a writer that finds
// the lock held waits up to busy_timeout instead of erroring out immediately.

import Database from 'better-sqlite3';
import type { PoolsSeed } from './types.js';

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      pool         TEXT NOT NULL,
      credentials  TEXT NOT NULL,
      leased_by    TEXT,
      lease_token  TEXT,
      leased_at    INTEGER,
      ttl_seconds  INTEGER,
      lease_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_pool_leasedby ON accounts (pool, leased_by);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_lease_token ON accounts (lease_token)
      WHERE lease_token IS NOT NULL;
  `,
};

/** Open the database, apply pragmas (WAL + busy_timeout) and run migrations. */
export function openDb(dbPath: string, busyTimeoutMs = 5000): Db {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number.parseInt(row.value, 10) : 0;

  const apply = db.transaction((from: number) => {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql) db.exec(sql);
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(String(SCHEMA_VERSION));
  });
  if (current < SCHEMA_VERSION) apply(current);
}

/**
 * Idempotent seed upsert. Adding accounts to the seed file and restarting must NOT clobber live
 * lease state — so this updates only `pool` + `credentials`, never the lease columns.
 * Returns the number of accounts inserted or updated.
 */
export function seedAccounts(db: Db, seed: PoolsSeed): number {
  const upsert = db.prepare(
    `INSERT INTO accounts (id, pool, credentials, lease_count)
       VALUES (@id, @pool, @credentials, 0)
     ON CONFLICT(id) DO UPDATE SET
       pool = excluded.pool,
       credentials = excluded.credentials`,
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const [pool, accounts] of Object.entries(seed.pools)) {
      for (const acc of accounts) {
        upsert.run({ id: acc.id, pool, credentials: JSON.stringify(acc.credentials) });
        count++;
      }
    }
  });
  tx();
  return count;
}

/** Force-clear all lease state (the `--reset-leases` startup flag). */
export function resetLeases(db: Db): number {
  const info = db
    .prepare(
      `UPDATE accounts
         SET leased_by = NULL, lease_token = NULL, leased_at = NULL, ttl_seconds = NULL
       WHERE leased_by IS NOT NULL`,
    )
    .run();
  return info.changes;
}
