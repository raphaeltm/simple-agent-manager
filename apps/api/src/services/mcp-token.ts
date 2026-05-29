/**
 * MCP Token Service
 *
 * Manages task-scoped opaque tokens for authenticating MCP tool calls from
 * agents running inside SAM workspaces. Tokens are stored in KV with a
 * configurable TTL and are validated (not consumed) on each use — unlike
 * bootstrap tokens, MCP tokens are reusable for the task's lifetime.
 *
 * Sliding window: on each validation, the KV TTL is refreshed so that active
 * agents never lose MCP access due to inactivity timeout. Writes are throttled
 * (only refresh when >50% of TTL has elapsed) to avoid excessive KV writes.
 * A hard max lifetime cap ensures tokens are eventually revoked regardless of
 * activity.
 */

import { DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS, DEFAULT_MCP_TOKEN_TTL_SECONDS } from '@simple-agent-manager/shared';

/** KV key prefix for MCP tokens */
const MCP_TOKEN_PREFIX = 'mcp:';

/** Env vars relevant to MCP token lifecycle */
export interface McpTokenEnv {
  MCP_TOKEN_TTL_SECONDS?: string;
  MCP_TOKEN_MAX_LIFETIME_SECONDS?: string;
}

/** Data stored alongside each MCP token in KV */
export interface McpTokenData {
  /**
   * Task ID for task-runner dispatched sessions. Empty string for direct
   * project-chat sessions (no task row exists). Tools that require a real
   * task guard on `!tokenData.taskId` which correctly rejects empty strings.
   */
  taskId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  agentSessionId?: string;
  createdAt: string;
  /** ISO timestamp of last sliding window refresh (set on first refresh) */
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
    const maxLifetime = parseInt(env.MCP_TOKEN_MAX_LIFETIME_SECONDS, 10);
    if (!isNaN(maxLifetime) && maxLifetime > 0) {
      return maxLifetime;
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
  // base64url encode without padding (explicit loop matches API token generation pattern)
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
 * Sliding window: if >50% of the TTL has elapsed since the last refresh
 * (or since creation), the KV entry's TTL is extended. This keeps tokens
 * alive for active agents while still expiring idle ones. A hard max
 * lifetime cap (MCP_TOKEN_MAX_LIFETIME_SECONDS) ensures eventual revocation.
 *
 * Fail-closed: if createdAt is malformed or missing, the token is revoked.
 *
 * @returns Token data if valid, null if invalid/expired/max-lifetime-exceeded
 */
export async function validateMcpToken(
  kv: KVNamespace,
  token: string,
  env?: McpTokenEnv,
): Promise<McpTokenData | null> {
  const key = `${MCP_TOKEN_PREFIX}${token}`;
  const data = await kv.get<McpTokenData>(key, { type: 'json' });
  if (!data) return null;

  const now = Date.now();
  const ttl = getMcpTokenTTL(env);
  const maxLifetime = getMcpTokenMaxLifetime(env);

  // Fail-closed: reject and revoke tokens with malformed createdAt.
  // Best-effort delete — KV errors must not turn an expiry into a 500.
  const createdAtMs = Date.parse(data.createdAt);
  if (isNaN(createdAtMs)) {
    void kv.delete(key).catch(() => {});
    return null;
  }

  // Hard max lifetime cap: reject tokens older than maxLifetime regardless of activity.
  // Best-effort delete — the KV TTL will expire the entry eventually anyway.
  const ageSeconds = (now - createdAtMs) / 1000;
  if (ageSeconds > maxLifetime) {
    void kv.delete(key).catch(() => {});
    return null;
  }

  // Sliding window: refresh KV TTL if >50% of TTL has elapsed since last refresh.
  // NOTE: This is a non-atomic read-modify-write over KV. Under concurrent MCP tool
  // calls from a single agent, multiple Workers may read the same data and all fire a
  // KV write near the refresh boundary. This produces redundant but correct writes —
  // the max lifetime cap is enforced on every read regardless of write ordering.
  const lastRefreshMs = data.lastRefreshedAt ? Date.parse(data.lastRefreshedAt) : createdAtMs;
  const elapsedSinceRefresh = (now - lastRefreshMs) / 1000;
  const refreshThreshold = ttl * 0.5;

  if (elapsedSinceRefresh > refreshThreshold) {
    const updatedData: McpTokenData = { ...data, lastRefreshedAt: new Date(now).toISOString() };
    // Cap the remaining TTL so it doesn't extend past max lifetime
    const remainingMaxLifetime = maxLifetime - ageSeconds;
    const effectiveTtl = Math.min(ttl, Math.max(1, Math.floor(remainingMaxLifetime)));
    await kv.put(key, JSON.stringify(updatedData), { expirationTtl: effectiveTtl });
    return updatedData;
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
