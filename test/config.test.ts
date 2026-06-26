import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseArgs, resolveCredentials } from '../src/config.js';
import { type Db, openDb, seedAccounts } from '../src/db.js';
import { redact } from '../src/logger.js';
import { AccountPool } from '../src/pool.js';
import type { PoolsSeed } from '../src/types.js';
import { cleanupDb, tempDbPath } from './helpers.js';

describe('config & flags', () => {
  it('flags override env override defaults', () => {
    const cfg = loadConfig(['--db', '/tmp/x.db', '--reset-leases'], {
      APM_DEFAULT_TTL_SECONDS: '60',
      APM_LEASE_WAIT_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(cfg.dbPath).toBe('/tmp/x.db');
    expect(cfg.resetLeases).toBe(true);
    expect(cfg.defaultTtlSeconds).toBe(60);
    expect(cfg.leaseWaitMs).toBe(5000);
  });

  it('rejects a non-numeric TTL env', () => {
    expect(() => loadConfig([], { APM_DEFAULT_TTL_SECONDS: 'soon' } as NodeJS.ProcessEnv)).toThrow(
      /APM_DEFAULT_TTL_SECONDS/,
    );
  });

  it('parseArgs handles --flag value and bare --flag', () => {
    expect(parseArgs(['--a', '1', '--b', '--c', 'x'])).toEqual({ a: '1', b: true, c: 'x' });
  });
});

describe('credential env-indirection', () => {
  it('resolves { env: "X" } from the environment at lease time', () => {
    const out = resolveCredentials(
      { username: 'qa01', password: { env: 'SECRET_PW' } },
      'realtor_01',
      { SECRET_PW: 'hunter2' } as NodeJS.ProcessEnv,
    );
    expect(out).toEqual({ username: 'qa01', password: 'hunter2' });
  });

  it('a missing env var surfaces a clear, actionable error', () => {
    expect(() =>
      resolveCredentials({ password: { env: 'NOPE_PW' } }, 'realtor_01', {} as NodeJS.ProcessEnv),
    ).toThrow(/NOPE_PW.*not set/s);
  });
});

describe('seed upsert does not clobber live leases on restart', () => {
  const paths: string[] = [];
  const conns: Db[] = [];
  afterEach(() => {
    for (const c of conns.splice(0)) c.close();
    for (const p of paths.splice(0)) cleanupDb(p);
  });

  it('keeps an in-flight lease across a re-seed (simulated restart)', () => {
    const path = tempDbPath();
    paths.push(path);
    const seed: PoolsSeed = {
      pools: { realtor: [{ id: 'realtor_01', credentials: { username: 'USER1' } }] },
    };

    const db1 = openDb(path);
    conns.push(db1);
    seedAccounts(db1, seed);
    const p1 = new AccountPool({ db: db1, defaultTtlSeconds: 1000 });
    const lease = p1.lease('realtor', 'holder-A');
    expect(lease).not.toBeNull();
    db1.close();
    conns.pop();

    // "restart": reopen + re-run the idempotent seed (now with an extra account added)
    const db2 = openDb(path);
    conns.push(db2);
    seedAccounts(db2, {
      pools: {
        realtor: [
          { id: 'realtor_01', credentials: { username: 'USER1' } },
          { id: 'realtor_02', credentials: { username: 'USER2' } },
        ],
      },
    });
    const p2 = new AccountPool({ db: db2, defaultTtlSeconds: 1000 });
    const [status] = p2.status('realtor');
    expect(status.total).toBe(2); // new account added
    expect(status.leased).toBe(1); // the live lease SURVIVED the re-seed
    expect(status.accounts.find((a) => a.account_id === 'realtor_01')?.state).toBe('leased');

    // and the original token still renews
    expect(p2.renew(lease!.lease_token, 1000).renewed).toBe(true);
  });
});

describe('redaction — no credential value ever escapes', () => {
  const paths: string[] = [];
  const conns: Db[] = [];
  afterEach(() => {
    for (const c of conns.splice(0)) c.close();
    for (const p of paths.splice(0)) cleanupDb(p);
  });

  it('redact() masks secret-looking keys recursively', () => {
    const masked = redact({
      username: 'qa01',
      password: 'hunter2',
      nested: { api_key: 'abc', token: 'xyz', note: 'keep' },
      list: [{ secret: 's' }],
    }) as Record<string, unknown>;
    expect(masked.password).toBe('***');
    expect((masked.nested as Record<string, unknown>).api_key).toBe('***');
    expect((masked.nested as Record<string, unknown>).token).toBe('***');
    expect((masked.nested as Record<string, unknown>).note).toBe('keep');
    expect((masked.list as Array<Record<string, unknown>>)[0].secret).toBe('***');
    expect(masked.username).toBe('qa01'); // username is not a secret
  });

  it('pool_status never includes credential values', () => {
    const path = tempDbPath();
    paths.push(path);
    const db = openDb(path);
    conns.push(db);
    seedAccounts(db, {
      pools: {
        realtor: [{ id: 'realtor_01', credentials: { username: 'qa01', password: 'topsecret' } }],
      },
    });
    const pool = new AccountPool({ db, defaultTtlSeconds: 1000 });
    pool.lease('realtor', 'A');
    const json = JSON.stringify(pool.status());
    expect(json).not.toContain('topsecret');
    expect(json).not.toContain('password');
  });
});
