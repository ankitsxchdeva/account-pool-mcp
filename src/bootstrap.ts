// Shared startup: open the DB, seed accounts (idempotent), optionally reset leases, build the pool.
// Used by both the MCP server entry (index.ts) and the CLI face (cli.ts) so they share one DB.

import { loadSeed } from './config.js';
import { type Db, openDb, resetLeases, seedAccounts } from './db.js';
import { logger } from './logger.js';
import { AccountPool } from './pool.js';
import type { AppConfig } from './types.js';

export interface Booted {
  db: Db;
  pool: AccountPool;
}

export function bootstrap(config: AppConfig, opts: { quiet?: boolean } = {}): Booted {
  const db = openDb(config.dbPath);

  if (config.resetLeases) {
    const cleared = resetLeases(db);
    if (!opts.quiet) logger.info('reset-leases: cleared lease state', { cleared });
  }

  const seed = loadSeed(config.accountsFile);
  if (seed) {
    const n = seedAccounts(db, seed);
    if (!opts.quiet) logger.info('seeded accounts (idempotent upsert)', { count: n });
  } else if (!opts.quiet) {
    logger.warn('no accounts file found — pools will be empty', {
      accountsFile: config.accountsFile,
    });
  }

  const pool = new AccountPool({ db, defaultTtlSeconds: config.defaultTtlSeconds });
  return { db, pool };
}
