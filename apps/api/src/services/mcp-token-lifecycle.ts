/**
 * Workspace lifecycle binding for workspace MCP tokens.
 *
 * A workspace MCP token (`mcp-token.ts`) is an opaque KV credential issued to one agent
 * session on one workspace. KV expiry alone lets it outlive that workspace by up to the
 * hard max lifetime, so every MCP entry point that accepts it (the `/mcp` JSON-RPC route,
 * webhook-claim redemption, the GCP deployment identity endpoint) also requires the
 * workspace D1 row it names to still be:
 *
 * - owned by the same user and project the token was issued for (otherwise the token is
 *   revoked: no later state can make it valid again), and
 * - active (`creating` / `running` / `recovery`) on a node that is not ending, exactly
 *   like workspace callback tokens (`assertWorkspaceAcceptsCallback`).
 *
 * - issued to the workspace's current runtime: its credential generation equals
 *   `workspaces.callback_generation` (both absent on a never-rotated workspace).
 *
 * A deleted or missing workspace, or a retired generation, revokes the token. Other inactive
 * states (stopping, stopped, sleeping, error) only reject: the same runtime may resume. A new
 * runtime for the same workspace ID (Instant wake, VM restart or rebuild) rotates the
 * generation, and its agent sessions receive fresh tokens (`session-restore-mcp.ts`,
 * `mcp-token-rotation.ts`).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { type McpTokenData, revokeMcpToken, validateMcpToken } from './mcp-token';
import { nodeStatusTerminatesCallbacks } from './node-callback-auth';
import { WORKSPACE_CALLBACK_ACTIVE_STATUSES } from './workspace-callback-identity';

interface McpTokenWorkspaceRow {
  userId: string;
  projectId: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
  callbackGeneration: string | null;
}

/** Why a token's workspace no longer authorizes it, or null when it does. */
type McpTokenWorkspaceVerdict = { reason: string; revoke: boolean } | null;

function workspaceVerdict(
  data: McpTokenData,
  row: McpTokenWorkspaceRow | null
): McpTokenWorkspaceVerdict {
  if (!row) return { reason: 'workspace_missing', revoke: true };
  if (row.userId !== data.userId || row.projectId !== data.projectId) {
    return { reason: 'identity_mismatch', revoke: true };
  }
  if (row.status === 'deleted') return { reason: 'workspace_deleted', revoke: true };
  // Issued to a runtime the workspace has since replaced: no later state can make it valid.
  if ((data.callbackGeneration ?? null) !== row.callbackGeneration) {
    return { reason: 'generation_retired', revoke: true };
  }
  if (!WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(row.status)) {
    return { reason: 'workspace_inactive', revoke: false };
  }
  if (!row.nodeId || !row.nodeStatus || nodeStatusTerminatesCallbacks(row.nodeStatus)) {
    return { reason: 'node_inactive', revoke: false };
  }
  return null;
}

/**
 * Validate a workspace MCP token and require its workspace to still be active.
 * Returns the token data, or null when the token is unknown, expired, or no longer
 * authorized by its workspace.
 */
export async function validateActiveWorkspaceMcpToken(
  env: Env,
  token: string
): Promise<McpTokenData | null> {
  const data = await validateMcpToken(env.KV, token, env);
  if (!data) return null;

  const row = data.workspaceId
    ? await env.DATABASE.prepare(
        `SELECT w.user_id AS userId,
                w.project_id AS projectId,
                w.status AS status,
                w.node_id AS nodeId,
                n.status AS nodeStatus,
                w.callback_generation AS callbackGeneration
           FROM workspaces w
           LEFT JOIN nodes n ON n.id = w.node_id
          WHERE w.id = ?
          LIMIT 1`
      )
        .bind(data.workspaceId)
        .first<McpTokenWorkspaceRow>()
    : null;

  const verdict = workspaceVerdict(data, row);
  if (!verdict) return data;

  log.info('mcp_token.workspace_rejected', {
    workspaceId: data.workspaceId || null,
    projectId: data.projectId,
    taskId: data.taskId || null,
    tokenUserId: data.userId,
    workspaceUserId: row?.userId ?? null,
    workspaceProjectId: row?.projectId ?? null,
    workspaceStatus: row?.status ?? 'missing',
    nodeStatus: row?.nodeStatus ?? null,
    reason: verdict.reason,
    action: verdict.revoke ? 'revoked' : 'rejected',
  });
  if (verdict.revoke) {
    // Best-effort: a KV failure must not turn a rejection into a 500.
    await revokeMcpToken(env.KV, token).catch(() => {});
  }
  return null;
}
