// Shared types for account-pool-mcp.

/**
 * A credential value is either a literal (string/number/bool) or an indirection
 * `{ env: "VAR_NAME" }` that is resolved from the process environment **at lease time**,
 * so real secrets never have to live in the seed file in plaintext.
 */
export type CredentialValue = string | number | boolean | { env: string };

/** Arbitrary credential blob — not hardwired to username/password. */
export type Credentials = Record<string, CredentialValue>;

/** Resolved credentials (after env indirection) handed back to a lease holder. */
export type ResolvedCredentials = Record<string, string | number | boolean>;

export interface AccountSeed {
  id: string;
  credentials: Credentials;
}

export interface PoolsSeed {
  pools: Record<string, AccountSeed[]>;
}

/** A single account row as stored in SQLite. */
export interface AccountRow {
  id: string;
  pool: string;
  credentials: string; // JSON-encoded Credentials
  leased_by: string | null;
  lease_token: string | null;
  leased_at: number | null; // epoch seconds
  ttl_seconds: number | null;
  lease_count: number;
}

export type ExhaustionPolicy = 'fail-fast' | 'block-and-wait';

export interface AppConfig {
  dbPath: string;
  accountsFile: string;
  defaultTtlSeconds: number;
  /** Max time to wait for a free account before failing. 0 = fail-fast. */
  leaseWaitMs: number;
  /** Clear all lease state on startup. */
  resetLeases: boolean;
}

export interface LeaseResult {
  account_id: string;
  pool: string;
  credentials: ResolvedCredentials;
  lease_token: string;
  expires_at: number; // epoch seconds
}

export interface ReleaseResult {
  released: boolean;
  account_id?: string;
}

export interface RenewResult {
  renewed: boolean;
  expires_at?: number;
  message?: string;
}

export type AccountState = 'free' | 'leased' | 'expired';

export interface AccountStatus {
  account_id: string;
  state: AccountState;
  holder?: string;
  expires_at?: number;
}

export interface PoolStatus {
  pool: string;
  total: number;
  available: number;
  leased: number;
  accounts: AccountStatus[];
}

/** Thrown when a pool has no free account and policy is fail-fast (or wait timed out). */
export class PoolExhaustedError extends Error {
  readonly pool: string;
  readonly total: number;
  readonly leased: number;
  constructor(pool: string, total: number, leased: number) {
    super(
      total === 0
        ? `Pool "${pool}" does not exist or has no accounts.`
        : `Pool "${pool}" is exhausted: all ${total} account(s) are currently leased (${leased} in use). Wait for a release, raise APM_LEASE_WAIT_MS to block-and-wait, or add more accounts.`,
    );
    this.name = 'PoolExhaustedError';
    this.pool = pool;
    this.total = total;
    this.leased = leased;
  }
}
