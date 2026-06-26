// Configuration: env vars, CLI flags, the accounts seed file, and credential env-indirection.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig, Credentials, PoolsSeed, ResolvedCredentials } from './types.js';

const DEFAULTS = {
  dbPath: './account-pool.db',
  accountsFile: './accounts.json',
  defaultTtlSeconds: 1800,
  leaseWaitMs: 0,
};

/** Minimal `--flag value` / `--flag` parser (no dependency). */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur?.startsWith('--')) continue;
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid ${name}="${raw}" — expected a non-negative integer.`);
  }
  return n;
}

/** Build the runtime config from CLI flags (highest precedence) then env then defaults. */
export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const flags = parseArgs(argv);
  const flagStr = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);

  return {
    dbPath: flagStr('db') ?? env.APM_DB_PATH ?? DEFAULTS.dbPath,
    accountsFile: flagStr('accounts') ?? env.APM_ACCOUNTS_FILE ?? DEFAULTS.accountsFile,
    defaultTtlSeconds: intEnv(env, 'APM_DEFAULT_TTL_SECONDS', DEFAULTS.defaultTtlSeconds),
    leaseWaitMs: intEnv(env, 'APM_LEASE_WAIT_MS', DEFAULTS.leaseWaitMs),
    resetLeases: flags['reset-leases'] === true,
  };
}

/** Load + shape-validate the accounts seed file. Returns `null` if the file is absent. */
export function loadSeed(accountsFile: string): PoolsSeed | null {
  let raw: string;
  try {
    raw = readFileSync(resolve(accountsFile), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Accounts file ${accountsFile} is not valid JSON: ${(err as Error).message}`);
  }
  const pools = (parsed as PoolsSeed)?.pools;
  if (!pools || typeof pools !== 'object') {
    throw new Error(`Accounts file ${accountsFile} must have a top-level "pools" object.`);
  }
  const seen = new Set<string>();
  for (const [pool, accounts] of Object.entries(pools)) {
    if (!Array.isArray(accounts)) {
      throw new Error(`Pool "${pool}" in ${accountsFile} must be an array of accounts.`);
    }
    for (const acc of accounts) {
      if (!acc?.id || typeof acc.id !== 'string') {
        throw new Error(`An account in pool "${pool}" is missing a string "id".`);
      }
      if (seen.has(acc.id)) {
        throw new Error(
          `Duplicate account id "${acc.id}" in ${accountsFile} — ids must be unique.`,
        );
      }
      seen.add(acc.id);
      if (!acc.credentials || typeof acc.credentials !== 'object') {
        throw new Error(`Account "${acc.id}" is missing a "credentials" object.`);
      }
    }
  }
  return parsed as PoolsSeed;
}

/**
 * Resolve credential env-indirection at lease time. A value `{ env: "X" }` becomes
 * `process.env.X`; a missing env var is a clear, actionable error (never a silent empty string).
 */
export function resolveCredentials(
  credentials: Credentials,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials {
  const out: ResolvedCredentials = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'object' && 'env' in value) {
      const envName = value.env;
      const resolved = env[envName];
      if (resolved === undefined || resolved === '') {
        throw new Error(
          `Account "${accountId}" credential "${key}" requires environment variable ` +
            `"${envName}", which is not set. Export it before leasing.`,
        );
      }
      out[key] = resolved;
    } else {
      out[key] = value as string | number | boolean;
    }
  }
  return out;
}
