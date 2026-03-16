/**
 * MCP Token Service
 *
 * Manages task-scoped opaque tokens for authenticating MCP tool calls from
 * agents running inside SAM workspaces. Tokens are stored in KV with a
 * configurable TTL and are validated (not consumed) on each use — unlike
 * bootstrap tokens, MCP tokens are reusable for the task's lifetime.
 */

/** KV key prefix for MCP tokens */
const MCP_TOKEN_PREFIX = 'mcp:';

/**
 * Default MCP token TTL in seconds (30 minutes).
 * Reduced from 2 hours to limit the post-completion attack window.
 * Override via MCP_TOKEN_TTL_SECONDS env var for longer-running tasks.
 */
const DEFAULT_MCP_TOKEN_TTL_SECONDS = 1800;

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

/**
 * Generate a cryptographically secure MCP token.
 */
export function generateMcpToken(): string {
  return crypto.randomUUID();
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
 * @returns Token data if valid, null if invalid or expired
 */
export async function validateMcpToken(
  kv: KVNamespace,
  token: string,
): Promise<McpTokenData | null> {
  const key = `${MCP_TOKEN_PREFIX}${token}`;
  return kv.get<McpTokenData>(key, { type: 'json' });
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
