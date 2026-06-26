import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestPool, setupPool } from './helpers.js';

describe('lease/release/renew lifecycle', () => {
  let t: TestPool;
  beforeEach(() => {
    t = setupPool({ pool: 'realtor', count: 3, defaultTtl: 100 });
  });
  afterEach(() => t.close());

  it('leases a free account with a token and resolved credentials', () => {
    const lease = t.pool.lease('realtor', 'QA-1');
    expect(lease).not.toBeNull();
    expect(lease?.account_id).toBe('realtor_01');
    expect(lease?.lease_token).toMatch(/^[0-9a-f]{24}$/);
    expect(lease?.credentials).toEqual({ username: 'USER1' });
    expect(lease?.expires_at).toBe(t.clock.now + 100);
  });

  it('never hands the same account to two leases', () => {
    const a = t.pool.lease('realtor', 'A');
    const b = t.pool.lease('realtor', 'B');
    expect(a?.account_id).not.toBe(b?.account_id);
  });

  it('a released account becomes immediately leasable again', () => {
    const a = t.pool.lease('realtor', 'A');
    t.pool.lease('realtor', 'B');
    t.pool.lease('realtor', 'C'); // pool now empty (3 accounts)
    expect(t.pool.lease('realtor', 'D')).toBeNull();

    const rel = t.pool.release(a!.lease_token);
    expect(rel).toEqual({ released: true, account_id: 'realtor_01' });

    const reused = t.pool.lease('realtor', 'D');
    expect(reused?.account_id).toBe('realtor_01');
  });

  it('release is idempotent: double-release and unknown tokens are no-ops', () => {
    const a = t.pool.lease('realtor', 'A');
    expect(t.pool.release(a!.lease_token).released).toBe(true);
    expect(t.pool.release(a!.lease_token)).toEqual({ released: false });
    expect(t.pool.release('not-a-real-token')).toEqual({ released: false });
  });

  it('release is scoped to the token — only the holder can release', () => {
    const a = t.pool.lease('realtor', 'A');
    const b = t.pool.lease('realtor', 'B');
    // releasing with A's token only frees A's account
    t.pool.release(a!.lease_token);
    const status = t.pool.status('realtor')[0];
    const bRow = status.accounts.find((x) => x.account_id === b!.account_id);
    expect(bRow?.state).toBe('leased');
  });

  it('renew extends a live lease', () => {
    const a = t.pool.lease('realtor', 'A', 100);
    t.clock.now += 50;
    const r = t.pool.renew(a!.lease_token, 100);
    expect(r.renewed).toBe(true);
    expect(r.expires_at).toBe(t.clock.now + 100);
  });

  it('renewing an unknown token returns renewed:false with guidance', () => {
    const r = t.pool.renew('nope');
    expect(r.renewed).toBe(false);
    expect(r.message).toMatch(/lease_account again/i);
  });

  it('pool_status reports totals and per-account state', () => {
    t.pool.lease('realtor', 'A');
    const [status] = t.pool.status('realtor');
    expect(status.total).toBe(3);
    expect(status.leased).toBe(1);
    expect(status.available).toBe(2);
    expect(status.accounts).toHaveLength(3);
  });

  it('status for an unknown pool returns an empty entry, not a throw', () => {
    const [status] = t.pool.status('ghost');
    expect(status).toEqual({ pool: 'ghost', total: 0, available: 0, leased: 0, accounts: [] });
  });
});
