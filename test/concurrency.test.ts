// THE headline test: prove that concurrent lease attempts never double-allocate an account.
//
// Two flavors:
//   1. Multi-connection, in-process, looped 20x — deterministic backbone. Many AccountPool
//      instances, each on its own connection to one shared DB file, all race to lease.
//   2. True OS parallelism via worker_threads — the gold-standard proof that BEGIN IMMEDIATE
//      serializes writers across real threads/connections.

import { Worker } from 'node:worker_threads';
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

  it('truly parallel worker threads also never double-allocate', async () => {
    const N = 10;
    const M = 40;
    const ITER = 3;

    for (let iter = 0; iter < ITER; iter++) {
      const path = tempDbPath();
      paths.push(path);
      const seeder = openDb(path);
      conns.push(seeder);
      seedAccounts(seeder, makeSeed(POOL, N));
      seeder.close();

      const workerUrl = new URL('./lease.worker.ts', import.meta.url);
      const runOne = () =>
        new Promise<string | null>((resolve, reject) => {
          const w = new Worker(workerUrl, {
            workerData: { dbPath: path, pool: POOL },
            execArgv: ['--import', 'tsx'],
          });
          w.once('message', (m: string | null) => resolve(m));
          w.once('error', reject);
        });

      const results = await Promise.all(Array.from({ length: M }, runOne));
      const winners = results.filter((r): r is string => r !== null);
      const ids = new Set(winners);

      expect(ids.size).toBe(winners.length); // no id handed out twice across threads
      expect(winners.length).toBe(N); // exactly the pool size was leased
    }
  }, 30_000);
});
