# account-pool-mcp

> An MCP server that hands out **exclusive, crash-safe leases** on a pool of credentials — so any
> number of **independent, unrelated agent sessions** can run browser/QA automation at the same time
> without two of them ever grabbing the same account.

[![CI](https://github.com/ankitsxchdeva/account-pool-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ankitsxchdeva/account-pool-mcp/actions/workflows/ci.yml)

---

## The problem

Run several autonomous agent sessions in parallel — each driving its own isolated Playwright
browser — and they all need to log in. Left to themselves they independently pick the **same** test
account and collide. Two sessions logged into one account corrupt each other's server-side state
(carts, drafts, folders, search state) and produce flaky, meaningless QA results.

**Randomly assigning an account per session does not fix this** — it just makes collisions
probabilistic. This is the birthday problem: with a pool of 10 and only 5 sessions choosing at
random, a collision is already *more likely than not*. The only correct fix is **exclusive
checkout**: a session *leases* an account, holds it for the duration of its work, and *releases* it;
while leased, no other session can be handed that account.

Playwright's own runner solves a narrower version of this with `parallelIndex` — but that only works
*inside one process* that owns all the workers. **Independent agent sessions have no shared parent
and no shared index**, so there's nothing to key off. `account-pool-mcp` fills that gap: a small,
standalone broker any number of unrelated sessions can call.

The accounts are just the first instance of a general pattern — **N autonomous agents contending for
a finite set of exclusive resources.** The same broker works for API keys, sandbox tenants, test
phone numbers, or any checkout-style resource.

## How it stays correct

One database file is the single source of truth. Every lease/release/renew runs inside a
**`BEGIN IMMEDIATE`** SQLite transaction, which takes the write lock *before* the read that picks an
account — so two simultaneous leases can never select the same free row (no time-of-check /
time-of-use gap). Combined with **WAL mode** and a `busy_timeout`, this holds even when *many
independent processes* (one per agent session) open the same file at once.

- **Atomic allocation** — `BEGIN IMMEDIATE` + `SELECT … WHERE leased_by IS NULL LIMIT 1` + mark, all
  in one transaction.
- **Crash recovery without liveness tracking** — sessions are opaque and may vanish. Each lease has
  a **TTL**; an abandoned lease simply expires and is reclaimed on the next lease attempt. No daemon,
  no cleanup job.
- **Synchronous SQLite** (`better-sqlite3`) removes a whole class of async-driver interleaving bugs.
- **CSPRNG lease tokens** (`crypto.randomBytes`), so a token can't be guessed and releases are
  scoped to the holder.

This is proven by a test, not asserted — see [Correctness is tested](#correctness-is-tested).

```
  agent session A ─┐
  agent session B ─┼──(MCP stdio)──▶ account-pool-mcp ──▶ SQLite (WAL)
  agent session C ─┘                    │
                                        ├─ lease_account
                                        ├─ release_account
                                        ├─ renew_lease   (heartbeat)
                                        └─ pool_status
```

## Quickstart (30 seconds)

```bash
# 1. Define your pools (copy the example, then edit). This file is gitignored.
cp examples/accounts.example.json accounts.json

# 2. Register it with your MCP client (see examples/claude-mcp-config.json):
#    "account-pool": { "command": "npx", "args": ["-y", "account-pool-mcp"],
#                      "env": { "APM_ACCOUNTS_FILE": "./accounts.json",
#                               "APM_DB_PATH": "./account-pool.db" } }

# That's it. Every session that loads this config now leases from one shared pool.
```

Prefer a CLI? The same broker ships a `account-pool` command over the same database:

```bash
npx account-pool lease realtor --holder QA-1234   # → account_id, lease_token, credentials
npx account-pool status realtor                   # who holds what
npx account-pool release <lease_token>
```

> **Shared database, many processes.** Independent sessions coordinate *through the database file*.
> Point every session's `APM_DB_PATH` at the **same stable path** — that's what makes the exclusivity
> guarantee span unrelated processes.

## The four tools

### `lease_account`
Claim one free account from a pool, exclusively, until released or the lease expires.

```jsonc
// request
{ "pool": "realtor", "holder": "QA-1234", "ttl_seconds": 1800 }
// response
{ "account_id": "realtor_01", "pool": "realtor",
  "credentials": { "username": "qa.realtor01@example.com", "password": "…" },
  "lease_token": "9f2c…", "expires_at": 1782489586 }
```
You **must** call `release_account` with the returned `lease_token` when finished. If your task may
outlast the TTL, call `renew_lease` to keep it.

### `release_account`
Release a leased account. **Idempotent** — releasing an already-released, expired, or unknown token
returns `{ "released": false }` rather than erroring.

```jsonc
{ "lease_token": "9f2c…" }   →   { "released": true, "account_id": "realtor_01" }
```

### `renew_lease` (heartbeat)
Extend the current lease so long-running work isn't reclaimed out from under it. If the lease already
expired and was reclaimed (or the token is unknown), returns `{ "renewed": false }` with guidance to
lease again — it never silently re-grants an account that may now be held by someone else.

```jsonc
{ "lease_token": "9f2c…", "ttl_seconds": 1800 }   →   { "renewed": true, "expires_at": 1782491386 }
```

### `pool_status`
Observability. Per pool: `total`, `available`, `leased`, and per-account `state`
(`free` / `leased` / `expired`) with holder + expiry. **Credential values are never returned.**

```jsonc
{ "pool": "realtor" }
→ { "pools": [ { "pool": "realtor", "total": 10, "available": 7, "leased": 3,
                 "accounts": [ { "account_id": "realtor_01", "state": "leased",
                                 "holder": "QA-1234", "expires_at": 1782489586 }, … ] } ] }
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `APM_ACCOUNTS_FILE` | `./accounts.json` | Pools + accounts seed file (idempotent upsert on start). |
| `APM_DB_PATH` | `./account-pool.db` | SQLite file. **Point all sessions at the same path.** |
| `APM_DEFAULT_TTL_SECONDS` | `1800` | Default lease lifetime. |
| `APM_LEASE_WAIT_MS` | `0` | Exhaustion policy: `0` = fail fast; `>0` = block-and-wait up to this long (jittered backoff) before failing. |
| `APM_DEBUG` | _(unset)_ | When set, emit debug logs (to stderr). |

| CLI flag | Meaning |
|---|---|
| `--db <path>` | Override `APM_DB_PATH`. |
| `--accounts <path>` | Override `APM_ACCOUNTS_FILE`. |
| `--reset-leases` | Clear all lease state on startup (fresh slate). Account *definitions* are kept. |

**Exhaustion policy.** Fail-fast (the default) is simplest when `sessions ≤ accounts`. Block-and-wait
(`APM_LEASE_WAIT_MS > 0`) lets you over-subscribe — queue more work than you have accounts and let
callers wait for a release.

### Credential indirection (keep secrets out of the seed file)

A credential value may be `{ "env": "REALTOR_01_PW" }`, resolved from the environment **at lease
time**. A missing env var surfaces a clear error instead of leasing an unusable account. Real secrets
never have to live in `accounts.json`.

```jsonc
{ "id": "realtor_01",
  "credentials": { "username": "qa.realtor01@example.com", "password": { "env": "REALTOR_01_PW" } } }
```

## Correctness is tested

The headline test seeds a pool of N and fires **M ≫ N concurrent lease attempts**, asserting that
**exactly N succeed, every returned `account_id` is distinct**, and the rest are turned away — run in
a loop so a rare interleaving surfaces. It runs two ways:

1. **Multi-connection, in-process** (M=100, N=10, ×20) — many connections to one file racing to lease.
2. **True OS parallelism via worker threads** (M=40, N=10) — independent threads, each its own
   connection, proving `BEGIN IMMEDIATE` serializes writers across real processes.

Plus TTL reclaim (injected clock — no sleeps), heartbeat, lifecycle/idempotency, seed-upsert that
preserves live leases across a restart, env indirection, and a redaction test asserting no credential
value ever appears in logs or `pool_status`.

```bash
npm test
```

## Security

This is for **test** accounts. It is not an auth provider, secrets vault, or identity system.

- **Credential values are never logged.** A redacting logger masks any secret-looking key; all logs
  go to **stderr** (stdout is the MCP protocol channel).
- `accounts.json` and `*.db` files are gitignored — only `.example` versions ship.
- The stdio server **trusts its local caller** (no network auth in v1). Don't point it at production
  credentials.

## Limitations & roadmap

- **Single host.** Coordination is via one SQLite file, so all sessions must share a filesystem. The
  storage layer (`src/db.ts`) is the only place that knows it's SQLite — a future Postgres/Redis
  backend can replace it behind the same tool surface for true multi-host coordination.
- **v1 transport is stdio.** HTTP/SSE transport (for remote/multi-host clients), a read-only status
  dashboard / `/metrics`, and lease analytics (utilization, wait-time histograms, busiest accounts)
  are on the roadmap.

## License

MIT — see [LICENSE](LICENSE).
