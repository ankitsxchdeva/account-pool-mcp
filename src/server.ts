// MCP server: registers the four tools and maps them onto the AccountPool. Tool descriptions are
// agent-facing — the wording is deliberate because the model reads it to decide how to behave.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger, redact } from './logger.js';
import type { AccountPool } from './pool.js';
import { leaseInput, releaseInput, renewInput, statusInput } from './schemas.js';
import type { AppConfig } from './types.js';
import { PoolExhaustedError } from './types.js';

interface ToolResult {
  // Index signature required by the MCP SDK's CallToolResult return type.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

export function buildServer(pool: AccountPool, config: AppConfig): McpServer {
  const server = new McpServer({ name: 'account-pool-mcp', version: '0.1.0' });

  server.tool(
    'lease_account',
    'Lease one account from the pool for browser login, EXCLUSIVELY, until you release it or the ' +
      'lease expires. No other session can be handed the same account while you hold it. You MUST ' +
      'call release_account with the returned lease_token when finished. If your task may run ' +
      'longer than the lease TTL, call renew_lease periodically to keep it.',
    leaseInput,
    async (args) => {
      try {
        const result = await pool.acquire({
          pool: args.pool,
          holder: args.holder,
          ttlSeconds: args.ttl_seconds,
          waitMs: args.wait_ms ?? config.leaseWaitMs,
        });
        logger.info('leased', {
          account_id: result.account_id,
          pool: result.pool,
          holder: args.holder ?? 'unknown',
          expires_at: result.expires_at,
        });
        return ok(result as unknown as Record<string, unknown>);
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return fail({
            error: 'pool_exhausted',
            pool: err.pool,
            total: err.total,
            leased: err.leased,
            message: err.message,
          });
        }
        logger.error('lease_account failed', { message: (err as Error).message });
        return fail({ error: 'lease_failed', message: (err as Error).message });
      }
    },
  );

  server.tool(
    'release_account',
    'Release a leased account so others can use it. Idempotent: releasing an already-released, ' +
      'expired, or unknown token returns released:false rather than erroring.',
    releaseInput,
    async (args) => {
      const result = pool.release(args.lease_token);
      logger.info('released', result);
      return ok(result as unknown as Record<string, unknown>);
    },
  );

  server.tool(
    'renew_lease',
    'Extend (heartbeat) the current lease so long-running work is not reclaimed out from under you. ' +
      'If the lease already expired and was reclaimed (or the token is unknown), returns ' +
      'renewed:false — do NOT assume you still hold the account; call lease_account again.',
    renewInput,
    async (args) => {
      const result = pool.renew(args.lease_token, args.ttl_seconds);
      return ok(result as unknown as Record<string, unknown>);
    },
  );

  server.tool(
    'pool_status',
    'Observability for the pools: totals, how many are available vs leased, and per-account state ' +
      '(free / leased / expired). Credential values are NEVER returned.',
    statusInput,
    async (args) => {
      const pools = pool.status(args.pool);
      // redact() is belt-and-suspenders: status() already omits credentials.
      return ok({ pools: redact(pools) } as Record<string, unknown>);
    },
  );

  return server;
}
