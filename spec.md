# account-pool-mcp — Build Specification

> A Model Context Protocol (MCP) server that brokers **exclusive leases** on a pool of
> credentials across **independent, unrelated agent sessions**. Built to let multiple
> Claude (or other agent) sessions run browser/QA automation concurrently without two
> sessions ever grabbing the same account.

This document is the build brief. Implement it as a real, publishable repository — not a
single-file script. Where this spec gives a code sketch, treat it as the contract for the
tricky part (correctness lives there); fill in the rest yourself with production-quality code.

---

## 1. Problem statement (put a version of this in the README)

When you run several autonomous agent sessions in parallel — each driving its own isolated
Playwright browser — and they all need to log in, they will independently pick the **same**
test account and collide. Two sessions logged into one account corrupt each other's state and
produce flaky, meaningless QA results.

Randomly assigning an account per session does **not** fix this — it just makes collisions
probabilistic (the birthday problem: with a pool of 10 and 5 sessions choosing randomly, a
collision is more likely than not). The only correct fix is **exclusive checkout**: a session
*leases* an account, holds it for the duration of its work, and *releases* it; while leased,
no other session can be handed that account.

Playwright's own test runner solves a narrower version of this with `parallelIndex`, but that
only works *inside one process* that owns all the workers. Independent agent sessions have no
shared parent and no shared index, so there is nothing to key off. This server fills that gap:
a small, standalone broker that any number of unrelated sessions can call.

The accounts are just the first instance of a general pattern — **N autonomous agents
contending for a finite set of exclusive resources**. The same broker works for API keys,
sandbox tenants, test phone numbers, or any checkout-style resource. Design accordingly.

---

## 2. Goals & non-goals

**Goals**

- Hand out accounts **exclusively** and **atomically** across concurrent, unrelated callers.
- Survive caller crashes (a session that dies mid-work must not strand its account forever).
- Survive server restarts without losing the account definitions.
- Be trivially usable by an LLM agent: a tiny, well-described tool surface.
- Support **multiple named pools** (e.g. `realtor`, `admin`, `buyer`) from one server.
- Be `npx`-runnable and easy to drop into an MCP client config.
- Ship with a test suite that actually proves the concurrency guarantee.

**Non-goals**

- Not an auth provider, secrets vault, or identity system. It stores *test* credentials.
- Not a general job queue or orchestrator. It does one thing: lease/release resources.
- No multi-machine/distributed coordination in v1 (single-host SQLite is the boundary).
  Note this limitation explicitly in the README; design the storage layer so a future
  Postgres/Redis backend could replace SQLite without changing the tool surface.

---

## 3. Tech stack (decided)

- **Language/runtime:** TypeScript, Node ≥ 20.
- **MCP:** `@modelcontextprotocol/sdk` (official), **stdio** transport for v1.
- **Storage:** `better-sqlite3` — synchronous API (no async race surprises), WAL mode.
- **Validation:** `zod` for every tool's input/output schema.
- **Tests:** `vitest`.
- **Lint/format:** `biome` (single tool) — eslint + prettier acceptable if preferred.
- **CI:** GitHub Actions.

Rationale worth a sentence in the README: SQLite + `BEGIN IMMEDIATE` gives real atomic
allocation with zero external infrastructure, and `better-sqlite3` being synchronous removes a
whole class of interleaving bugs that an async driver would invite.

---

## 4. Architecture overview

```
  Claude session A ─┐
  Claude session B ─┼──(MCP stdio)──▶ account-pool-mcp ──▶ SQLite (WAL)
  Claude session C ─┘                    │
                                         ├─ lease_account
                                         ├─ release_account
                                         ├─ renew_lease   (heartbeat)
                                         └─ pool_status
```

One server process owns the SQLite file and is the single source of truth. All mutation goes
through `BEGIN IMMEDIATE` transactions, so even simultaneous lease attempts are serialized and
can never be handed the same row. Crash recovery is handled by lease TTLs, not by tracking
session liveness (sessions are opaque and may vanish without notice).

---

## 5. Data model

Single table `accounts` (plus a `meta` table for schema version / migrations).

| column        | type    | notes                                                        |
|---------------|---------|--------------------------------------------------------------|
| `id`          | TEXT PK | stable id, e.g. `realtor_03` (from the seed file)            |
| `pool`        | TEXT    | pool name, e.g. `realtor`                                    |
| `credentials` | TEXT    | JSON blob (username/password, or arbitrary keys). Redacted in all output. |
| `leased_by`   | TEXT    | holder label or NULL when free                               |
| `lease_token` | TEXT    | opaque token returned to the holder; NULL when free          |
| `leased_at`   | INTEGER | epoch seconds the current lease started/renewed; NULL when free |
| `ttl_seconds` | INTEGER | TTL for the *current* lease; NULL when free                  |
| `lease_count` | INTEGER | lifetime number of times leased (cheap analytics)            |

Indexes: `(pool, leased_by)` and `(lease_token)`.

Notes:
- `credentials` is an arbitrary JSON object so the server is not hardwired to username/password.
- A lease is "expired" when `leased_at + ttl_seconds < now`. Expired leases are reclaimable.
- Account **definitions** persist across restarts. Lease state also persists (don't wipe on
  boot); stale leases from a crashed run will TTL-expire naturally. Provide a `--reset-leases`
  flag to force-clear all lease state on startup for a clean slate.

---

## 6. Tool surface (the MCP API)

Keep it to these four tools. Every description below is agent-facing — the wording matters
because the model reads it to decide how to behave. Validate all inputs with zod.

### 6.1 `lease_account`

Claim one free account from a pool, exclusively, until released or the lease expires.

- **Input:**
  - `pool` (string, required) — which pool to lease from.
  - `holder` (string, optional) — a label for who's holding it (e.g. the Jira ticket id
    `QA-1234`). Used only for observability/debugging. Defaults to `"unknown"`.
  - `ttl_seconds` (int, optional) — lease lifetime; defaults to server default TTL.
- **Output:**
  - `account_id`, `pool`, `credentials` (the JSON blob), `lease_token`, `expires_at` (epoch).
- **Description (agent-facing):** "Lease one account from the pool for browser login. You MUST
  call `release_account` with the returned `lease_token` when finished. If your task may run
  longer than the lease TTL, call `renew_lease` periodically to keep it."
- **Behavior on empty pool:** governed by exhaustion policy (§8). Either fail fast with a clear
  error, or block-and-wait up to a timeout, then error.

### 6.2 `release_account`

Release a leased account so others can use it.

- **Input:** `lease_token` (string, required).
- **Output:** `{ released: boolean, account_id?: string }`.
- **Idempotent:** releasing an already-released/expired/unknown token returns
  `{ released: false }` rather than throwing. Releasing is scoped to the token, so a caller can
  only release the account it holds.

### 6.3 `renew_lease` (heartbeat)

Extend the current lease so long-running work doesn't get reclaimed out from under it.

- **Input:** `lease_token` (string, required), `ttl_seconds` (int, optional).
- **Output:** `{ renewed: boolean, expires_at?: number }`.
- **Edge case:** if the lease has already expired and been reclaimed (or the token is unknown),
  return `{ renewed: false }` with a message instructing the agent to call `lease_account`
  again. Do **not** silently re-grant — the account may now be held by someone else.

### 6.4 `pool_status`

Observability. Never returns credential values.

- **Input:** `pool` (string, optional) — omit for all pools.
- **Output:** per pool: `total`, `available`, `leased`, and a per-account list of
  `{ account_id, state: "free"|"leased"|"expired", holder?, expires_at? }` with **credentials
  fully redacted**.

---

## 7. Concurrency & correctness (the hard requirement)

This is the part that must be exactly right. Requirements:

1. Open the DB in **WAL** mode (`journal_mode=WAL`) and set a sensible `busy_timeout`.
2. Every lease/release/renew runs inside a **`BEGIN IMMEDIATE`** transaction so the write lock
   is acquired *before* the read that picks an account. This prevents two simultaneous leases
   from selecting the same row (no time-of-check/time-of-use gap).
3. Reclaiming expired leases happens **inside the same transaction** as the claim, immediately
   before the `SELECT ... WHERE leased_by IS NULL LIMIT 1`.
4. The lease token is generated with a CSPRNG (`crypto.randomBytes`), not `Math.random`.

Reference sketch for the claim (adapt to the codebase; this is the contract, not the final code):

```ts
function leaseAccount(pool: string, holder: string, ttl: number) {
  const now = Math.floor(Date.now() / 1000);
  const txn = db.transaction(() => {
    // 1) reclaim anything whose lease has expired
    db.prepare(
      `UPDATE accounts
         SET leased_by = NULL, lease_token = NULL, leased_at = NULL, ttl_seconds = NULL
       WHERE pool = ? AND leased_by IS NOT NULL
         AND (leased_at + ttl_seconds) < ?`
    ).run(pool, now);

    // 2) grab one free account
    const row = db.prepare(
      `SELECT id, credentials FROM accounts
        WHERE pool = ? AND leased_by IS NULL
        LIMIT 1`
    ).get(pool);
    if (!row) return null; // caller applies exhaustion policy

    // 3) mark it leased
    const token = crypto.randomBytes(12).toString("hex");
    db.prepare(
      `UPDATE accounts
         SET leased_by = ?, lease_token = ?, leased_at = ?, ttl_seconds = ?,
             lease_count = lease_count + 1
       WHERE id = ?`
    ).run(holder, token, now, ttl, row.id);

    return { account_id: row.id, credentials: JSON.parse(row.credentials),
             lease_token: token, expires_at: now + ttl, pool };
  });
  // better-sqlite3 transactions are IMMEDIATE-capable; ensure the wrapper uses BEGIN IMMEDIATE
  return txn.immediate ? txn.immediate() : txn();
}
```

**Correctness must be proven by a test, not asserted** — see §11.

---

## 8. Exhaustion policy (pool empty)

Configurable, with both modes implemented:

- **fail-fast** (default): return a structured error immediately — pool name, total accounts,
  how many are leased — so the agent can report "no accounts available" cleanly.
- **block-and-wait:** poll for a free account with bounded backoff (e.g. 250ms → 2s, jittered)
  up to a max wait, then fail-fast. Useful when queuing more tickets than there are accounts.

Controlled by `APM_LEASE_WAIT_MS` (env default; `0` = fail-fast) and optionally overridable
per call. Document the tradeoff in the README (fail-fast simpler when `sessions ≤ accounts`;
block-and-wait lets you over-subscribe).

---

## 9. Configuration

- **Accounts seed file** (`APM_ACCOUNTS_FILE`, default `./accounts.json`): defines pools and
  accounts. Loaded at startup with an idempotent **upsert** — adding accounts to the file and
  restarting must not clobber existing lease state. This file is **gitignored**; commit an
  `accounts.example.json`.
- **Credential indirection (do implement — it's a repo-quality touch):** a credential value may
  be `{ "env": "REALTOR_3_PASSWORD" }`, resolved from the environment at lease time, so real
  secrets never have to live in the seed file in plaintext.
- **Env vars:**
  - `APM_DB_PATH` (default `./account-pool.db`)
  - `APM_DEFAULT_TTL_SECONDS` (default e.g. 1800)
  - `APM_LEASE_WAIT_MS` (default `0`)
  - `APM_ACCOUNTS_FILE`
- **CLI flags:** `--reset-leases`, `--db <path>`, `--accounts <path>`.

Example `accounts.example.json`:

```json
{
  "pools": {
    "realtor": [
      { "id": "realtor_01", "credentials": { "username": "qa.realtor01@example.com", "password": { "env": "REALTOR_01_PW" } } },
      { "id": "realtor_02", "credentials": { "username": "qa.realtor02@example.com", "password": { "env": "REALTOR_02_PW" } } }
    ],
    "admin": [
      { "id": "admin_01", "credentials": { "username": "qa.admin01@example.com", "password": { "env": "ADMIN_01_PW" } } }
    ]
  }
}
```

---

## 10. Security requirements

- **Never log credential values.** Provide a redacting logger; all log lines and `pool_status`
  output show `***` for credential fields.
- Seed file and `*.db` files are gitignored. Ship `.example` versions only.
- README disclaimer: this is for **test** accounts; do not point it at production credentials,
  and the stdio server trusts its local caller (no network auth in v1).

---

## 11. Testing requirements (this is what makes it a repo, not a gist)

Use `vitest`. Tests must run deterministically in CI (no flakiness).

1. **Concurrency / no-double-allocation (the headline test):** seed a pool of N (e.g. 10).
   Fire M ≫ N (e.g. 100) concurrent `lease_account` calls. Assert: exactly N succeed, every
   returned `account_id` is **distinct** (a `Set` of size N), and the remaining M−N either
   error (fail-fast) or queue (block-and-wait). Run this assertion in a loop (e.g. 20 iters)
   so a rare interleaving bug surfaces.
2. **TTL reclaim:** lease all accounts, advance time past TTL (inject a clock or use short
   TTLs), confirm a new lease reclaims an expired one.
3. **Heartbeat:** renew before expiry keeps the account; renewing an already-reclaimed lease
   returns `renewed: false`.
4. **Lifecycle / idempotency:** double-release is a no-op; releasing an unknown token is a
   no-op; a released account becomes immediately leasable.
5. **Config:** seed upsert doesn't clobber live leases on restart; credential `env`
   indirection resolves correctly; missing env var surfaces a clear error.
6. **Redaction:** assert no credential value ever appears in logs or `pool_status` output.

Make the clock injectable (pass a `now()` function) so TTL tests don't rely on `sleep`.

---

## 12. Repo structure

```
account-pool-mcp/
├── src/
│   ├── index.ts        # bin entry: parse flags/env, start stdio MCP server
│   ├── server.ts       # registers the 4 tools, maps to pool logic
│   ├── pool.ts         # lease/release/renew/status core logic
│   ├── db.ts           # sqlite open (WAL), migrations, prepared statements
│   ├── config.ts       # load accounts file + env, credential indirection
│   ├── schemas.ts      # zod schemas for all tool I/O
│   ├── logger.ts       # redacting logger
│   └── types.ts
├── test/
│   ├── concurrency.test.ts
│   ├── ttl.test.ts
│   ├── lifecycle.test.ts
│   └── config.test.ts
├── examples/
│   ├── accounts.example.json
│   ├── claude-mcp-config.json   # how to register the server in an MCP client
│   └── playwright-usage.md      # lease → login → release flow for an agent
├── .github/workflows/ci.yml     # install, lint, typecheck, test
├── .gitignore                   # accounts.json, *.db, node_modules, dist
├── biome.json
├── tsconfig.json
├── package.json                 # bin: account-pool-mcp; scripts; npx-ready
├── LICENSE                      # MIT
└── README.md
```

---

## 13. Packaging & DX

- `package.json` exposes a `bin` named `account-pool-mcp` so it runs via
  `npx account-pool-mcp`. Build to `dist/` with a shebang entry.
- `examples/claude-mcp-config.json` shows the exact stanza to add it as an MCP server
  alongside the Jira and Playwright MCPs.
- CI (`ci.yml`): on push/PR — `install → biome check → tsc --noEmit → vitest run`. The
  concurrency test running green in CI is the proof point; keep it in the default run.

---

## 14. README requirements

The README is a deliverable, not an afterthought — it's what makes this share-worthy. Include:

1. The **problem framing** from §1, including the "why randomization fails (birthday problem)"
   explainer and the note that Playwright's `parallelIndex` only works intra-process.
2. A 30-second quickstart (`npx`, seed file, MCP config snippet).
3. The four tools with example request/response.
4. Configuration table (env vars, flags, exhaustion policy).
5. An ASCII architecture diagram (the one in §4 is fine).
6. A short "how it stays correct" section (BEGIN IMMEDIATE + WAL + TTL reclaim) — this is the
   part that earns trust.
7. Limitations (single-host; test-account scope; stdio trusts local caller) and the
   "future backends" note.

---

## 15. Build milestones (work in this order)

1. **Scaffold** — package.json, tsconfig, biome, deps; a stdio MCP server that lists the 4
   tools and returns stubs. Verify it connects in MCP Inspector.
2. **DB layer** — schema, migrations, WAL, prepared statements; seed loader with upsert.
3. **Core leasing** — `lease`/`release` with `BEGIN IMMEDIATE` and TTL reclaim.
4. **Renew + status** — heartbeat and redacted observability.
5. **Exhaustion policy** — fail-fast and block-and-wait with jittered backoff.
6. **Config polish** — credential `env` indirection, redacting logger, CLI flags.
7. **Tests** — all of §11, with injectable clock; make the concurrency test loop.
8. **Ship** — CI, README, examples, `npx` packaging.

---

## 16. Definition of done

- [ ] All four tools work end-to-end via MCP Inspector.
- [ ] Concurrency test passes deterministically across repeated runs in CI (zero duplicate
      account_ids ever).
- [ ] Crashed/abandoned leases auto-recover via TTL; `renew_lease` extends long holds.
- [ ] Restart preserves account definitions and in-flight leases; `--reset-leases` clears them.
- [ ] No credential value ever appears in logs or `pool_status`.
- [ ] `npx account-pool-mcp` starts the server; example MCP config registers it cleanly.
- [ ] README covers problem framing, quickstart, tools, config, correctness, limitations.
- [ ] CI is green (lint + typecheck + tests).

---

## 17. Stretch goals (only after DoD; mention as "Roadmap" in README)

- Read-only HTTP status dashboard / `/metrics` endpoint (contention, avg hold time).
- Additional transport (HTTP/SSE) so remote/multi-host clients can use it.
- Pluggable storage backend (Postgres/Redis) behind the existing pool interface for true
  multi-host coordination.
- Lease analytics: per-pool utilization, wait-time histograms, busiest accounts.

