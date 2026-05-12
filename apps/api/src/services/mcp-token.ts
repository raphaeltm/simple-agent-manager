/**
 * MCP Token Service
 *
 * Manages task-scoped opaque tokens for authenticating MCP tool calls from
 * agents running inside SAM workspaces. Tokens are stored in KV with a
 * configurable TTL and are validated (not consumed) on each use — unlike
 * bootstrap tokens, MCP tokens are reusable for the task's lifetime.
 *
 * Sliding window: on each validation, if >50% of the TTL has elapsed since
 * creation (or last refresh), the KV entry is re-written with a fresh TTL.
 * This keeps tokens alive for long-running agents without issuing new tokens.
 * A hard maximum lifetime (default 24h, configurable via MCP_TOKEN_MAX_LIFETIME_SECONDS)
 * caps how long a token can be extended.
 */

import { DEFAULT_MCP_TOKEN_TTL_SECONDS } from '@simple-agent-manager/shared';

/** KV key prefix for MCP tokens */
const MCP_TOKEN_PREFIX = 'mcp:';

/** Default maximum lifetime for MCP tokens: 24 hours */
const DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

/** Sliding window refresh threshold: refresh when >50% of TTL has elapsed */
const SLIDING_WINDOW_THRESHOLD = 0.5;

/** Env shape for MCP token configuration */
export interface McpTokenEnv {
  MCP_TOKEN_TTL_SECONDS?: string;
  MCP_TOKEN_MAX_LIFETIME_SECONDS?: string;
}

/** Data stored alongside each MCP token in KV */
export interface McpTokenData {
  taskId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  createdAt: string;
  /** ISO-8601 timestamp of the last sliding-window TTL refresh */
  lastRefreshedAt?: string;
}

/** Get MCP token TTL from env or use default (per constitution principle XI) */
export function getMcpTokenTTL(env?: McpTokenEnv): number {
  if (env?.MCP_TOKEN_TTL_SECONDS) {
    const ttl = parseInt(env.MCP_TOKEN_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) {
      return ttl;
    }
  }
  return DEFAULT_MCP_TOKEN_TTL_SECONDS;
}

/** Get MCP token max lifetime from env or use default */
export function getMcpTokenMaxLifetime(env?: McpTokenEnv): number {
  if (env?.MCP_TOKEN_MAX_LIFETIME_SECONDS) {
    const val = parseInt(env.MCP_TOKEN_MAX_LIFETIME_SECONDS, 10);
    if (!isNaN(val) && val > 0) {
      return val;
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
  env?: McpTokenEnv,
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
 * Sliding window: when >50% of the TTL has elapsed since the last refresh
 * (or creation), re-writes the KV entry with a fresh TTL. This extends the
 * token's life for long-running agents. Capped by max lifetime (default 24h).
 *
 * @returns Token data if valid, null if invalid or expired
 */
export async function validateMcpToken(
  kv: KVNamespace,
  token: string,
  env?: McpTokenEnv,
): Promise<McpTokenData | null> {
  const key = `${MCP_TOKEN_PREFIX}${token}`;
  const data = await kv.get<McpTokenData>(key, { type: 'json' });
  if (!data) return null;

  // Sliding window refresh: extend TTL if >50% has elapsed and max lifetime not reached
  if (env) {
    const ttl = getMcpTokenTTL(env);
    const maxLifetime = getMcpTokenMaxLifetime(env);
    const now = Date.now();
    const createdAt = new Date(data.createdAt).getTime();
    const lastRefreshed = data.lastRefreshedAt
      ? new Date(data.lastRefreshedAt).getTime()
      : createdAt;

    const elapsed = now - lastRefreshed;
    const thresholdMs = ttl * 1000 * SLIDING_WINDOW_THRESHOLD;
    const ageMs = now - createdAt;

    // Only refresh if past the threshold AND within max lifetime
    if (elapsed > thresholdMs && ageMs < maxLifetime * 1000) {
      // Cap remaining TTL to not exceed max lifetime from creation
      const remainingLifetime = Math.max(0, (maxLifetime * 1000 - ageMs) / 1000);
      const refreshTtl = Math.min(ttl, Math.ceil(remainingLifetime));

      if (refreshTtl > 60) {
        // Only refresh if >60s remaining (avoid pointless tiny refreshes)
        const refreshedData: McpTokenData = {
          ...data,
          lastRefreshedAt: new Date(now).toISOString(),
        };
        await kv.put(key, JSON.stringify(refreshedData), {
          expirationTtl: refreshTtl,
        });
      }
    }
  }

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
