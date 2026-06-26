#!/usr/bin/env node
// account-pool — CLI face for the same broker. Lets shell scripts and humans lease/release/renew/
// status against the SAME SQLite database the MCP server uses (no MCP round-trip). This is what an
// existing auth script shells out to so account assignment becomes an invisible step.
//
//   account-pool lease <pool> [--holder h] [--ttl secs] [--wait-ms ms] [--json] [--field key]
//   account-pool release <lease_token>
//   account-pool renew <lease_token> [--ttl secs]
//   account-pool status [pool] [--json]

import { bootstrap } from './bootstrap.js';
import { loadConfig, parseArgs } from './config.js';
import { PoolExhaustedError } from './types.js';

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

async function main(): Promise<number> {
  const [, , sub, ...rest] = process.argv;
  // positional args (before any --flag) and flags, parsed separately
  const positionals = rest.filter((a) => !a.startsWith('--'));
  const flags = parseArgs(rest);
  const config = loadConfig(rest);
  const { pool } = bootstrap(config, { quiet: true });

  switch (sub) {
    case 'lease': {
      const poolName = positionals[0];
      if (!poolName) {
        out(
          'usage: account-pool lease <pool> [--holder h] [--ttl secs] [--wait-ms ms] [--json] [--field key]',
        );
        return 2;
      }
      try {
        const result = await pool.acquire({
          pool: poolName,
          holder: typeof flags.holder === 'string' ? flags.holder : undefined,
          ttlSeconds: typeof flags.ttl === 'string' ? Number.parseInt(flags.ttl, 10) : undefined,
          waitMs:
            typeof flags['wait-ms'] === 'string'
              ? Number.parseInt(flags['wait-ms'], 10)
              : config.leaseWaitMs,
        });
        if (typeof flags.field === 'string') {
          const v = result.credentials[flags.field];
          if (v === undefined) {
            process.stderr.write(
              `credential field "${flags.field}" not present on ${result.account_id}\n`,
            );
            return 4;
          }
          out(String(v));
        } else if (flags.json) {
          out(JSON.stringify(result));
        } else {
          out(`account_id=${result.account_id}`);
          out(`lease_token=${result.lease_token}`);
          out(`expires_at=${result.expires_at}`);
          for (const [k, v] of Object.entries(result.credentials)) out(`${k}=${v}`);
        }
        return 0;
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          process.stderr.write(`${err.message}\n`);
          return 3;
        }
        throw err;
      }
    }

    case 'release': {
      const token = positionals[0];
      if (!token) {
        out('usage: account-pool release <lease_token>');
        return 2;
      }
      const result = pool.release(token);
      out(
        flags.json
          ? JSON.stringify(result)
          : `released=${result.released}${result.account_id ? ` account_id=${result.account_id}` : ''}`,
      );
      return 0;
    }

    case 'renew': {
      const token = positionals[0];
      if (!token) {
        out('usage: account-pool renew <lease_token> [--ttl secs]');
        return 2;
      }
      const result = pool.renew(
        token,
        typeof flags.ttl === 'string' ? Number.parseInt(flags.ttl, 10) : undefined,
      );
      out(
        flags.json
          ? JSON.stringify(result)
          : `renewed=${result.renewed}${result.expires_at ? ` expires_at=${result.expires_at}` : ''}`,
      );
      return result.renewed ? 0 : 5;
    }

    case 'status': {
      const pools = pool.status(positionals[0]);
      if (flags.json) {
        out(JSON.stringify(pools, null, 2));
      } else {
        for (const p of pools) {
          out(`# ${p.pool}: ${p.available}/${p.total} available, ${p.leased} leased`);
          for (const a of p.accounts) {
            const tail =
              a.state === 'leased'
                ? `  held by ${a.holder} until ${new Date((a.expires_at ?? 0) * 1000).toISOString()}`
                : a.state === 'expired'
                  ? `  (expired; reclaimable — was ${a.holder})`
                  : '';
            out(`  ${a.account_id.padEnd(16)} ${a.state}${tail}`);
          }
        }
      }
      return 0;
    }

    default:
      out('usage: account-pool <lease|release|renew|status> ...');
      out(
        '  account-pool lease <pool> [--holder h] [--ttl secs] [--wait-ms ms] [--json] [--field key]',
      );
      out('  account-pool release <lease_token>');
      out('  account-pool renew <lease_token> [--ttl secs]');
      out('  account-pool status [pool] [--json]');
      return sub ? 2 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exit(1);
  });
