# account-pool-mcp

[![npm version](https://img.shields.io/npm/v/account-pool-mcp.svg)](https://www.npmjs.com/package/account-pool-mcp)
[![npm downloads](https://img.shields.io/npm/dw/account-pool-mcp.svg)](https://www.npmjs.com/package/account-pool-mcp)
[![CI](https://github.com/ankitsxchdeva/account-pool-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ankitsxchdeva/account-pool-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/account-pool-mcp.svg)](./LICENSE)
[![Model Context Protocol](https://img.shields.io/badge/MCP-server-blue.svg)](https://modelcontextprotocol.io)
[![Glama score](https://glama.ai/mcp/servers/ankitsxchdeva/account-pool-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ankitsxchdeva/account-pool-mcp)

An MCP server that hands out test accounts to agent sessions one at a time, so two sessions never
end up logged into the same account.

![account-pool-mcp demo: two sessions lease different accounts, a third is refused, the pool recovers on release](https://raw.githubusercontent.com/ankitsxchdeva/account-pool-mcp/main/docs/demo.gif)

## The problem

When you run several agent sessions at once — say a few Claude sessions each driving their own
Playwright browser — they all need to log in, and left alone they'll grab the same test account and
step on each other. Two sessions on one account corrupt each other's state and your test results
become meaningless. Picking a random account doesn't really help either: with 10 accounts and 5
sessions, a collision is already more likely than not.

The fix is to lease accounts. A session checks one out, uses it, and returns it. While it's checked
out, no one else can be handed it.

## How it works

The server keeps a pool of accounts in a small SQLite database and gives them out one at a time.
Allocation happens inside a `BEGIN IMMEDIATE` transaction, so even if several sessions ask at the
exact same moment, they can't be handed the same account. Each lease has a TTL, so if a session
crashes without returning its account, it gets reclaimed automatically — there's nothing to clean up.

All of this happens in the background. The agent just asks for an account when it needs one; the
broker decides which one it gets and guarantees no one else has it. There's no shared parent process
— unrelated sessions coordinate purely through the database file.

## Tools

- `lease_account(pool, holder?)` — check out an account. Returns the account, its credentials, and a
  `lease_token`. Hold it until you're done.
- `release_account(lease_token)` — give it back. Idempotent.
- `renew_lease(lease_token)` — extend the lease if your work runs long (a heartbeat).
- `pool_status(pool?)` — what's leased vs. free. Never returns credential values.

There's also a small `account-pool` CLI (`lease` / `release` / `renew` / `status`) over the same
database, for scripts and humans.

## Setup

Want to see it first? `bash examples/demo.sh` runs a 60-second, no-install walkthrough — two sessions
lease different accounts, a third is correctly refused, and the pool recovers on release.

It's on [npm](https://www.npmjs.com/package/account-pool-mcp), so there's nothing to clone or build.
Register it with your MCP client (e.g. `.mcp.json`) — `npx` fetches and caches it on first launch:

```jsonc
{
  "mcpServers": {
    "account-pool": {
      "command": "npx",
      "args": ["-y", "account-pool-mcp"],
      "env": {
        "APM_ACCOUNTS_FILE": "./accounts.json",
        "APM_DB_PATH": "./account-pool.db"
      }
    }
  }
}
```

Then define your pools in `accounts.json` (an `id` and a credentials blob per account):

```json
{ "pools": { "realtor": [
  { "id": "realtor_01", "credentials": { "username": "qa01@example.com", "password": { "env": "REALTOR_01_PW" } } }
] } }
```

Want the CLI too? Run it ad-hoc with `npx account-pool status`, or install it on your PATH:

```bash
npm install -g account-pool-mcp     # adds `account-pool` (CLI) and `account-pool-mcp` (server)
```

Point every session's `APM_DB_PATH` at the same file — that shared file is how they coordinate.

| Env var | Default | What it does |
|---|---|---|
| `APM_ACCOUNTS_FILE` | `./accounts.json` | Pools + accounts to load on startup. |
| `APM_DB_PATH` | `./account-pool.db` | The SQLite file. Same path for every session. |
| `APM_DEFAULT_TTL_SECONDS` | `1800` | How long a lease lasts before it's reclaimable. |
| `APM_LEASE_WAIT_MS` | `0` | `0` = fail fast when the pool is empty; `>0` = wait this long for one to free up. |

A credential value can be `{ "env": "VAR_NAME" }` instead of a literal, so real secrets stay in the
environment and out of the accounts file.

## Making your agent reach for it automatically

The server ships **agent instructions** in the MCP handshake — clients like Claude Code, Cursor, and
Windsurf inject them into context, so the agent knows to call `lease_account` before logging in
without being told each time. The tool descriptions reinforce it (lease is exclusive; you *must*
release).

For the most reliable pickup, also add a line to your project's own rules file
(`CLAUDE.md`, `.cursor/rules/`, `.windsurfrules`) so the agent's instructions and the server's
instructions agree:

```md
## Test accounts
This repo has account-pool-mcp configured. Before logging into any test account in a QA or
Playwright run, call `lease_account` to check one out, and `release_account` when done.
Never hard-code, guess, or reuse an account — one account per session at a time.
```

## Security

These are test accounts, not a secrets vault. Credential values are never logged or returned by
`pool_status` — a redacting logger masks them, and all logs go to stderr so they can't corrupt the
MCP stream. Keep `accounts.json` and `*.db` out of git (only the `.example` files are committed). The
stdio server trusts whoever runs it locally, so don't point it at production credentials.

## Limitations

Single host for now: coordination is through one SQLite file, so all sessions have to share a
filesystem. The storage layer is isolated behind one module, so a Postgres or Redis backend could
swap in later for multi-host coordination without changing the tools.
