// Core leasing logic — the part that must be exactly right.
//
// The concurrency guarantee comes from running every mutation inside a `BEGIN IMMEDIATE`
// transaction (better-sqlite3's `.immediate()` variant). IMMEDIATE takes the write lock BEFORE the
// SELECT that picks an account, so two simultaneous lease attempts can never read the same free row
// and both claim it (no time-of-check / time-of-use gap). Combined with WAL + busy_timeout, this
// holds across many independent processes sharing one database file.

import { randomBytes } from 'node:crypto';
import { resolveCredentials } from './config.js';
import type { Db } from './db.js';
import {
  type Credentials,
  type LeaseResult,
  PoolExhaustedError,
  type PoolStatus,
  type ReleaseResult,
  type RenewResult,
} from './types.js';

export interface AccountPoolOptions {
  db: Db;
  defaultTtlSeconds: number;
  /** Injectable clock (epoch SECONDS) so TTL tests don't rely on sleep. */
  now?: () => number;
  /** Environment used to resolve credential `{ env: "X" }` indirection. */
  env?: NodeJS.ProcessEnv;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AccountPool {
  private readonly db: Db;
  private readonly defaultTtl: number;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;

  // Prepared statements (compiled once).
  private readonly stmtReclaim;
  private readonly stmtSelectFree;
  private readonly stmtMarkLeased;
  private readonly stmtRelease;
  private readonly stmtByToken;
  private readonly stmtRenew;
  private readonly stmtPoolCounts;
  private readonly stmtStatusRows;

  constructor(opts: AccountPoolOptions) {
    this.db = opts.db;
    this.defaultTtl = opts.defaultTtlSeconds;
    this.now = opts.now ?? nowSeconds;
    this.env = opts.env ?? process.env;

    this.stmtReclaim = this.db.prepare(
      `UPDATE accounts
         SET leased_by = NULL, lease_token = NULL, leased_at = NULL, ttl_seconds = NULL
       WHERE pool = ? AND leased_by IS NOT NULL AND (leased_at + ttl_seconds) < ?`,
    );
    this.stmtSelectFree = this.db.prepare(
      'SELECT id, credentials FROM accounts WHERE pool = ? AND leased_by IS NULL LIMIT 1',
    );
    this.stmtMarkLeased = this.db.prepare(
      `UPDATE accounts
         SET leased_by = ?, lease_token = ?, leased_at = ?, ttl_seconds = ?,
             lease_count = lease_count + 1
       WHERE id = ?`,
    );
    this.stmtRelease = this.db.prepare(
      `UPDATE accounts
         SET leased_by = NULL, lease_token = NULL, leased_at = NULL, ttl_seconds = NULL
       WHERE lease_token = ? RETURNING id`,
    );
    this.stmtByToken = this.db.prepare(
      'SELECT id, leased_at, ttl_seconds FROM accounts WHERE lease_token = ?',
    );
    this.stmtRenew = this.db.prepare(
      'UPDATE accounts SET leased_at = ?, ttl_seconds = ? WHERE lease_token = ? RETURNING id',
    );
    this.stmtPoolCounts = this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN leased_by IS NOT NULL THEN 1 ELSE 0 END), 0) AS leased
       FROM accounts WHERE pool = ?`,
    );
    this.stmtStatusRows = this.db.prepare(
      'SELECT id, pool, leased_by, leased_at, ttl_seconds FROM accounts',
    );
  }

  /**
   * Single atomic attempt to lease one free account. Returns the lease or `null` if the pool has no
   * free account right now (caller applies the exhaustion policy — see {@link acquire}).
   */
  lease(pool: string, holder = 'unknown', ttlSeconds?: number): LeaseResult | null {
    const ttl = this.validateTtl(ttlSeconds ?? this.defaultTtl);
    const now = this.now();

    const txn = this.db.transaction((): LeaseResult | null => {
      // 1) reclaim anything in this pool whose lease has expired
      this.stmtReclaim.run(pool, now);
      // 2) grab one free account
      const row = this.stmtSelectFree.get(pool) as { id: string; credentials: string } | undefined;
      if (!row) return null;
      // 3) resolve credentials BEFORE committing the claim — a missing env var rolls the whole
      //    transaction back so we never leave an account leased-but-unusable.
      const creds = resolveCredentials(
        JSON.parse(row.credentials) as Credentials,
        row.id,
        this.env,
      );
      // 4) mark it leased
      const token = randomBytes(12).toString('hex');
      this.stmtMarkLeased.run(holder, token, now, ttl, row.id);
      return {
        account_id: row.id,
        pool,
        credentials: creds,
        lease_token: token,
        expires_at: now + ttl,
      };
    });
    // IMMEDIATE: take the write lock before the read so two leases can't pick the same row.
    return txn.immediate();
  }

  /**
   * Lease one account, applying the exhaustion policy. `waitMs === 0` → fail fast with a structured
   * {@link PoolExhaustedError}. `waitMs > 0` → block-and-wait, polling with jittered backoff up to
   * `waitMs` before failing.
   */
  async acquire(args: {
    pool: string;
    holder?: string;
    ttlSeconds?: number;
    waitMs?: number;
  }): Promise<LeaseResult> {
    const { pool, holder, ttlSeconds } = args;
    const waitMs = args.waitMs ?? 0;
    const deadline = this.nowMs() + waitMs;

    let backoff = 250;
    for (;;) {
      const result = this.lease(pool, holder, ttlSeconds);
      if (result) return result;
      if (this.nowMs() >= deadline) {
        const { total, leased } = this.poolCounts(pool);
        throw new PoolExhaustedError(pool, total, leased);
      }
      // jittered backoff, capped, never overshooting the deadline
      const jitter = Math.floor(Math.random() * 100);
      const wait = Math.min(backoff + jitter, Math.max(0, deadline - this.nowMs()));
      await sleep(wait);
      backoff = Math.min(backoff * 2, 2000);
    }
  }

  /** Release a leased account. Idempotent: an unknown/already-free/expired token returns false. */
  release(leaseToken: string): ReleaseResult {
    const txn = this.db.transaction((): ReleaseResult => {
      const row = this.stmtRelease.get(leaseToken) as { id: string } | undefined;
      return row ? { released: true, account_id: row.id } : { released: false };
    });
    return txn.immediate();
  }

  /** Extend a live lease. A token that is unknown OR already expired returns `renewed: false`. */
  renew(leaseToken: string, ttlSeconds?: number): RenewResult {
    const ttl = this.validateTtl(ttlSeconds ?? this.defaultTtl);
    const now = this.now();

    const txn = this.db.transaction((): RenewResult => {
      const row = this.stmtByToken.get(leaseToken) as
        | { id: string; leased_at: number | null; ttl_seconds: number | null }
        | undefined;
      const expired =
        !row || row.leased_at === null || row.ttl_seconds === null
          ? true
          : row.leased_at + row.ttl_seconds < now;
      if (!row || expired) {
        return {
          renewed: false,
          message:
            'Lease is unknown or already expired and may now be held by another session. ' +
            'Call lease_account again to get a fresh account.',
        };
      }
      this.stmtRenew.run(now, ttl, leaseToken);
      return { renewed: true, expires_at: now + ttl };
    });
    return txn.immediate();
  }

  /** Observability. Never returns credential values. */
  status(pool?: string): PoolStatus[] {
    const now = this.now();
    const rows = this.stmtStatusRows.all() as Array<{
      id: string;
      pool: string;
      leased_by: string | null;
      leased_at: number | null;
      ttl_seconds: number | null;
    }>;

    const byPool = new Map<string, PoolStatus>();
    for (const r of rows) {
      if (pool && r.pool !== pool) continue;
      let ps = byPool.get(r.pool);
      if (!ps) {
        ps = { pool: r.pool, total: 0, available: 0, leased: 0, accounts: [] };
        byPool.set(r.pool, ps);
      }
      ps.total++;
      if (r.leased_by === null) {
        ps.available++;
        ps.accounts.push({ account_id: r.id, state: 'free' });
      } else {
        const expired =
          r.leased_at === null || r.ttl_seconds === null || r.leased_at + r.ttl_seconds < now;
        if (expired) {
          ps.available++; // an expired lease is reclaimable on the next lease attempt
          ps.accounts.push({ account_id: r.id, state: 'expired', holder: r.leased_by });
        } else {
          ps.leased++;
          ps.accounts.push({
            account_id: r.id,
            state: 'leased',
            holder: r.leased_by,
            expires_at: (r.leased_at as number) + (r.ttl_seconds as number),
          });
        }
      }
    }
    // An explicit pool filter that matches nothing still yields an (empty) entry for clarity.
    if (pool && !byPool.has(pool)) {
      byPool.set(pool, { pool, total: 0, available: 0, leased: 0, accounts: [] });
    }
    return [...byPool.values()].sort((a, b) => a.pool.localeCompare(b.pool));
  }

  private poolCounts(pool: string): { total: number; leased: number } {
    return this.stmtPoolCounts.get(pool) as { total: number; leased: number };
  }

  private nowMs(): number {
    // Wall-clock for backoff timing; independent of the injectable second-clock used for TTL logic.
    return Date.now();
  }

  private validateTtl(ttl: number): number {
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error(`ttl_seconds must be a positive integer, got ${ttl}.`);
    }
    return ttl;
  }
}
