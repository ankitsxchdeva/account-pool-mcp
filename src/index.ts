#!/usr/bin/env node
// account-pool-mcp — stdio MCP server entry point.
//
// Brokers exclusive, crash-safe leases on a pool of credentials across independent agent sessions.
// Flags: --db <path>  --accounts <path>  --reset-leases   (env: APM_DB_PATH, APM_ACCOUNTS_FILE,
// APM_DEFAULT_TTL_SECONDS, APM_LEASE_WAIT_MS). All logging goes to stderr; stdout is the MCP channel.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { pool } = bootstrap(config);
  const server = buildServer(pool, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('account-pool-mcp ready (stdio)', {
    db: config.dbPath,
    defaultTtlSeconds: config.defaultTtlSeconds,
    leaseWaitMs: config.leaseWaitMs,
  });
}

main().catch((err) => {
  logger.error('fatal', { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
