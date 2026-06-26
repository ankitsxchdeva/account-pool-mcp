// The headline test: concurrent lease attempts must never hand out the same account twice.
//
// Each "session" gets its own connection to one shared database file, then they all race to lease.
// Because every lease runs in a BEGIN IMMEDIATE transaction, exactly N of M racers can win (N = pool
// size) and every winner gets a distinct account. Repeated many times so a rare interleaving surfaces.

import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openDb, seedAccounts } from '../src/db.js';
import { AccountPool } from '../src/pool.js';
import { cleanupDb, makeSeed, tempDbPath } from './helpers.js';

const POOL = 'realtor';

describe('concurrency — no double allocation', () => {
  const paths: string[] = [];
  const conns: Db[] = [];
  afterEach(() => {
    for (const c of conns.splice(0)) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    for (const p of paths.splice(0)) cleanupDb(p);
  });

  it('M=100 racers over a pool of N=10 → exactly 10 distinct, repeated 20x', () => {
    const N = 10;
    const M = 100;
    const ITER = 20;

    for (let iter = 0; iter < ITER; iter++) {
      const path = tempDbPath();
      paths.push(path);
      const seeder = openDb(path);
      conns.push(seeder);
      seedAccounts(seeder, makeSeed(POOL, N));

      // M independent connections, each its own AccountPool — like M unrelated sessions.
      const pools = Array.from({ length: M }, () => {
        const db = openDb(path);
        conns.push(db);
        return new AccountPool({ db, defaultTtlSeconds: 1000 });
      });

      const results = pools.map((p) => p.lease(POOL, 'racer'));
      const winners = results.filter((r): r is NonNullable<typeof r> => r !== null);
      const ids = new Set(winners.map((w) => w.account_id));
      const tokens = new Set(winners.map((w) => w.lease_token));

      expect(winners).toHaveLength(N); // exactly N succeed
      expect(ids.size).toBe(N); // all account_ids distinct — no double allocation
      expect(tokens.size).toBe(N); // every winner got a unique token
      expect(results.filter((r) => r === null)).toHaveLength(M - N); // the rest got nothing
    }
  });
});
