import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestPool, setupPool } from './helpers.js';

describe('TTL reclaim & heartbeat (injected clock — no sleep)', () => {
  let t: TestPool;
  beforeEach(() => {
    t = setupPool({ pool: 'realtor', count: 2, defaultTtl: 100, startTime: 1_000_000 });
  });
  afterEach(() => t.close());

  it('reclaims an expired lease so a new caller can take it', () => {
    const a = t.pool.lease('realtor', 'A', 100);
    t.pool.lease('realtor', 'B', 100); // pool now full (2 accounts)
    expect(t.pool.lease('realtor', 'C', 100)).toBeNull();

    // advance past A's TTL — A is now reclaimable
    t.clock.now += 101;
    const c = t.pool.lease('realtor', 'C', 100);
    expect(c?.account_id).toBe(a!.account_id); // A's slot was reclaimed and reassigned
  });

  it('a crashed holder (never releases) self-heals via TTL', () => {
    // lease all, then "crash" — we simply never release
    t.pool.lease('realtor', 'crashed-1', 100);
    t.pool.lease('realtor', 'crashed-2', 100);
    const [before] = t.pool.status('realtor');
    expect(before.leased).toBe(2);

    t.clock.now += 200; // both TTLs elapse
    const [after] = t.pool.status('realtor');
    expect(after.leased).toBe(0); // both shown reclaimable
    expect(after.available).toBe(2);
    expect(after.accounts.every((x) => x.state === 'expired')).toBe(true);

    // and they are actually leasable again
    expect(t.pool.lease('realtor', 'fresh')).not.toBeNull();
  });

  it('renewing before expiry protects that account from reclaim', () => {
    const a = t.pool.lease('realtor', 'A', 100); // realtor_01, expires 1_000_100
    t.pool.lease('realtor', 'B', 100); // realtor_02, expires 1_000_100 (NOT renewed)

    t.clock.now += 90; // 1_000_090
    expect(t.pool.renew(a!.lease_token, 100).renewed).toBe(true); // A now expires 1_000_190

    t.clock.now += 20; // 1_000_110: B has expired, A (renewed) has not
    const c = t.pool.lease('realtor', 'C', 100);
    expect(c?.account_id).toBe('realtor_02'); // only B's slot was reclaimed
    const [status] = t.pool.status('realtor');
    expect(status.accounts.find((x) => x.account_id === a!.account_id)?.state).toBe('leased');

    // once A's renewed TTL also elapses, it too becomes reclaimable
    t.clock.now += 100; // 1_000_210 > 1_000_190
    const [later] = t.pool.status('realtor');
    expect(later.accounts.find((x) => x.account_id === a!.account_id)?.state).toBe('expired');
  });

  it('renewing an already-expired (reclaimed) lease returns renewed:false', () => {
    const a = t.pool.lease('realtor', 'A', 100);
    t.clock.now += 101; // A expired
    const r = t.pool.renew(a!.lease_token, 100);
    expect(r.renewed).toBe(false);
    expect(r.message).toMatch(/lease_account again/i);
  });
});
