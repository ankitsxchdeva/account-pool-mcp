#!/usr/bin/env bash
# account-pool-mcp — 60-second demo: parallel sessions, zero collisions.
#
# Run from the repo root:   bash examples/demo.sh
# Record a GIF with asciinema + agg:
#   asciinema rec demo.cast -c 'bash examples/demo.sh' && agg demo.cast demo.gif
#
# It seeds a throwaway 2-account pool in a temp dir, then shows two sessions leasing
# distinct accounts, a third session correctly refused, and the pool recovering on release.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export APM_DB_PATH="$WORK/pool.db"
export APM_ACCOUNTS_FILE="$WORK/accounts.json"
export QA01_PW="s3cret-01" QA02_PW="s3cret-02"

cat > "$APM_ACCOUNTS_FILE" <<'JSON'
{ "pools": { "demo": [
  { "id": "qa_01", "credentials": { "username": "qa01@example.com", "password": { "env": "QA01_PW" } } },
  { "id": "qa_02", "credentials": { "username": "qa02@example.com", "password": { "env": "QA02_PW" } } }
] } }
JSON

# Local source CLI so the demo runs without installing. After `npm i -g account-pool-mcp`
# the exact same commands are just `account-pool ...`.
pool() { node --import tsx "$ROOT/src/cli.ts" "$@"; }
say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; sleep 0.6; }
run()  { printf '\033[2m$ %s\033[0m\n' "$*"; "$@"; sleep 0.8; }

say "A pool with two test accounts, nothing leased yet"
run pool status demo

say "Session A checks one out — it gets qa_01"
A_OUT=$(pool lease demo --holder session-A); echo "$A_OUT"
A_TOKEN=$(printf '%s\n' "$A_OUT" | sed -n 's/^lease_token=//p'); sleep 0.8

say "Session B checks one out — it CANNOT get qa_01, so it gets qa_02"
run pool lease demo --holder session-B

say "Both accounts are now held by different sessions"
run pool status demo

say "Session C asks for one — pool is exhausted, so it is refused (no double-booking)"
printf '\033[2m$ pool lease demo --holder session-C\033[0m\n'
pool lease demo --holder session-C || printf '\033[33m→ refused (exit %s): no free account, as designed\033[0m\n' "$?"
sleep 0.8

say "Session A finishes and releases qa_01"
run pool release "$A_TOKEN"

say "qa_01 is free again — Session C can now have it"
run pool lease demo --holder session-C

say "Done. Independent sessions coordinated through one SQLite file — no shared parent process."
