// Worker body for the true-parallelism concurrency test. Each worker opens its OWN connection to
// the shared database file and makes a single atomic lease attempt — so M of these running at once
// exercise BEGIN IMMEDIATE across real OS threads, not just the JS event loop.

import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../src/db.js';
import { AccountPool } from '../src/pool.js';

const { dbPath, pool: poolName } = workerData as { dbPath: string; pool: string };

const db = openDb(dbPath);
const pool = new AccountPool({ db, defaultTtlSeconds: 1000 });
const result = pool.lease(poolName, 'worker');
db.close();

parentPort?.postMessage(result ? result.account_id : null);
