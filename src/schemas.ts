// Zod input shapes for the four MCP tools. Kept as raw shapes so they can be passed straight to the
// MCP SDK's tool registration (which derives the JSON Schema the agent sees).

import { z } from 'zod';

export const leaseInput = {
  pool: z.string().min(1).describe('Which pool to lease from, e.g. "realtor" or "admin".'),
  holder: z
    .string()
    .optional()
    .describe('A label for who is holding it (e.g. a Jira ticket id). Observability only.'),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Lease lifetime in seconds. Defaults to the server default TTL.'),
  wait_ms: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Override the block-and-wait timeout for this call. 0 = fail fast on an empty pool.'),
};

export const releaseInput = {
  lease_token: z.string().min(1).describe('The lease_token returned by lease_account.'),
};

export const renewInput = {
  lease_token: z.string().min(1).describe('The lease_token returned by lease_account.'),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('New lease lifetime in seconds from now. Defaults to the server default TTL.'),
};

export const statusInput = {
  pool: z.string().optional().describe('Limit to one pool. Omit for all pools.'),
};

// Re-exported for tests / typing.
export const leaseInputSchema = z.object(leaseInput);
export const releaseInputSchema = z.object(releaseInput);
export const renewInputSchema = z.object(renewInput);
export const statusInputSchema = z.object(statusInput);
