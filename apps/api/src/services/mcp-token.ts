/**
 * MCP Token Service
 *
 * Manages task-scoped opaque tokens for authenticating MCP tool calls from
 * agents running inside SAM workspaces. Tokens are stored in KV with a
 * configurable TTL and are validated (not consumed) on each use — unlike
 * bootstrap tokens, MCP tokens are reusable for the task's lifetime.
 */

import {
  DEFAULT_MCP_TOKEN_TTL_SECONDS,
  DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS,
} from '@simple-agent-manager/shared';

/** KV key prefix for MCP tokens */
const MCP_TOKEN_PREFIX = 'mcp:';

/** Data stored alongside each MCP token in KV */
export interface McpTokenData {
  taskId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  createdAt: string;
}

/** Get MCP token TTL from env or use default (per constitution principle XI) */
export function getMcpTokenTTL(env?: { MCP_TOKEN_TTL_SECONDS?: string }): number {
  if (env?.MCP_TOKEN_TTL_SECONDS) {
    const ttl = parseInt(env.MCP_TOKEN_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) {
      return ttl;
    }
  }
  return DEFAULT_MCP_TOKEN_TTL_SECONDS;
}

/** Get MCP token max lifetime from env or use default (per constitution principle XI) */
export function getMcpTokenMaxLifetime(env?: { MCP_TOKEN_MAX_LIFETIME_SECONDS?: string }): number {
  if (env?.MCP_TOKEN_MAX_LIFETIME_SECONDS) {
    const seconds = parseInt(env.MCP_TOKEN_MAX_LIFETIME_SECONDS, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds;
    }
  }
  return DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS;
}

/**
 * Generate a cryptographically secure MCP token (256-bit entropy, base64url encoded).
 */
export function generateMcpToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url encode without padding (explicit loop matches smoke-test-tokens.ts pattern)
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Store an MCP token in KV with configurable TTL.
 * The token auto-expires after TTL.
 */
export async function storeMcpToken(
  kv: KVNamespace,
  token: string,
  data: McpTokenData,
  env?: { MCP_TOKEN_TTL_SECONDS?: string },
): Promise<void> {
  const ttl = getMcpTokenTTL(env);
  await kv.put(`${MCP_TOKEN_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: ttl,
  });
}

/**
 * Validate an MCP token and return its associated data.
 * Unlike bootstrap tokens, MCP tokens are NOT consumed on validation —
 * agents may call multiple tools during a single task.
 *
 * Implements a sliding window TTL: each successful validation refreshes the
 * KV expiration so the token stays alive as long as the agent is actively
 * using it. A hard max lifetime cap (default 24h) prevents leaked tokens
 * from living forever.
 *
 * @returns Token data if valid, null if invalid/expired/past max lifetime
 */
export async function validateMcpToken(
  kv: KVNamespace,
  token: string,
  env?: { MCP_TOKEN_TTL_SECONDS?: string; MCP_TOKEN_MAX_LIFETIME_SECONDS?: string },
): Promise<McpTokenData | null> {
  const key = `${MCP_TOKEN_PREFIX}${token}`;
  const data = await kv.get<McpTokenData>(key, { type: 'json' });
  if (!data) return null;

  // Enforce hard max lifetime — reject tokens older than the cap
  if (data.createdAt) {
    const maxLifetimeMs = getMcpTokenMaxLifetime(env) * 1000;
    const age = Date.now() - new Date(data.createdAt).getTime();
    if (age > maxLifetimeMs) {
      // Token exceeded max lifetime — revoke and reject
      await kv.delete(key);
      return null;
    }
  }

  // Sliding window: refresh the TTL so the token stays alive while in use
  const ttl = getMcpTokenTTL(env);
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });

  return data;
}

/**
 * Revoke an MCP token (e.g., when task completes or fails).
 */
export async function revokeMcpToken(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  await kv.delete(`${MCP_TOKEN_PREFIX}${token}`);
}
