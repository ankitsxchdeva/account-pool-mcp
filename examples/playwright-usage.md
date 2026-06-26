# Using account-pool-mcp with Playwright (agent flow)

The pattern any agent (Claude or otherwise) should follow when it needs to log in: **lease → use →
release**, with a heartbeat for long work. Because the lease is exclusive and atomic, no other
session can be handed the same account while you hold it.

## The flow

```
1. lease_account({ pool: "realtor", holder: "QA-1234" })
      → { account_id, credentials: { username, password }, lease_token, expires_at }

2. Drive Playwright with the leased credentials:
      - log in as `username` / `password`
      - (or load a pre-saved storage state keyed by account_id / username)
      - run your test flow in an ISOLATED browser context

3. If the work may outlast the TTL, periodically:
      renew_lease({ lease_token })          # heartbeat — call between test cases / every few minutes

4. When finished (success OR failure):
      release_account({ lease_token })       # hand the account back to the pool
```

## Why each step matters

- **Exclusive lease** — two sessions can never drive the same account at once, so they can't corrupt
  each other's server-side state (carts, drafts, folders, search state). This is the whole point.
- **Heartbeat (`renew_lease`)** — a lease has a TTL so a crashed session can't strand an account
  forever. If your real work runs longer than the TTL, renew to keep your hold. If `renew_lease`
  returns `renewed: false`, the lease already expired and may now be held by someone else — stop and
  `lease_account` again; do not keep using the old account.
- **Release** — returns the account immediately instead of waiting for the TTL. Always release in a
  finally/teardown step. If your process dies before releasing, the TTL reclaims it automatically —
  that's the crash-safety net, not the happy path.

## Empty pool

If every account is leased, `lease_account` either fails fast with a structured error (default) or
blocks-and-waits up to `APM_LEASE_WAIT_MS` before failing. Handle the failure by reporting "no
accounts available" rather than proceeding without an exclusive account.

## Storage-state variant (no live password in the flow)

If you pre-bake a Playwright storage state per account, the lease only needs to tell you *which*
account is yours: lease a pool whose credentials contain just a `username`/account id, then load the
matching saved storage-state blob and skip the live login entirely. The exclusivity guarantee is the
same — you just use the lease to pick the storage state instead of to log in.
