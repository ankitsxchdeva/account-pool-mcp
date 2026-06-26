import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, openDb, seedAccounts } from '../src/db.js';
import { AccountPool } from '../src/pool.js';
import type { PoolsSeed } from '../src/types.js';

export function tempDbPath(): string {
  return join(tmpdir(), `apm-test-${randomBytes(8).toString('hex')}.db`);
}

export function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(path + suffix, { force: true });
  }
}

/** Build a seed with `n` accounts in one pool: `<pool>_01`.. with username `USER<i>`. */
export function makeSeed(pool: string, n: number): PoolsSeed {
  const accounts = Array.from({ length: n }, (_, i) => ({
    id: `${pool}_${String(i + 1).padStart(2, '0')}`,
    credentials: { username: `USER${i + 1}` },
  }));
  return { pools: { [pool]: accounts } };
}

export interface TestPool {
  db: Db;
  pool: AccountPool;
  path: string;
  /** A controllable clock, in epoch seconds. */
  clock: { now: number };
  close: () => void;
}

/** Open a fresh temp-file DB, seed it, and build a pool with an injectable clock. */
export function setupPool(opts: {
  pool?: string;
  count?: number;
  defaultTtl?: number;
  startTime?: number;
  env?: NodeJS.ProcessEnv;
  seed?: PoolsSeed;
}): TestPool {
  const path = tempDbPath();
  const db = openDb(path);
  const seed = opts.seed ?? makeSeed(opts.pool ?? 'realtor', opts.count ?? 10);
  seedAccounts(db, seed);
  const clock = { now: opts.startTime ?? 1_000_000 };
  const pool = new AccountPool({
    db,
    defaultTtlSeconds: opts.defaultTtl ?? 1800,
    now: () => clock.now,
    env: opts.env,
  });
  return {
    db,
    pool,
    path,
    clock,
    close: () => {
      db.close();
      cleanupDb(path);
    },
  };
}
