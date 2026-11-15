/**
 * Workspace and actor lifecycle binding for workspace MCP tokens.
 *
 * A workspace MCP token (`mcp-token.ts`) is an opaque KV credential issued to one agent
 * session on one workspace, acting as the workspace's owner in the workspace's project. KV
 * expiry alone lets it outlive that workspace, and that owner's authority, by up to the hard
 * max lifetime, so every MCP entry point that accepts it (the `/mcp` JSON-RPC route,
 * webhook-claim redemption, the GCP deployment identity endpoint) also requires, in ONE D1
 * read, that the workspace row it names is still:
 *
 * - owned by the same user and project the token was issued for,
 * - owned by a user whose account still exists and is not suspended,
 * - owned by a user with an ACTIVE `project_members` row in that project (the same
 *   predicate REST uses in `requireActiveProjectMembership`; project owners hold an
 *   active `owner` row from creation, migration 0081 backfill, and ownership transfer),
 * - issued to the workspace's current runtime: its credential generation equals
 *   `workspaces.callback_generation` (both absent on a never-rotated workspace), and
 * - active (`creating` / `running` / `recovery`) on a node that is not ending, exactly
 *   like workspace callback tokens (`assertWorkspaceAcceptsCallback`).
 *
 * A failed check either REVOKES the token (deletes it from KV: no later state can make it
 * valid, and rotation cannot recover a deleted token) or only REJECTS the call (the token
 * works again once the state recovers). Checks run in this order; the first failure wins:
 *
 * | Condition                                             | Verdict | Reason                     |
 * | ----------------------------------------------------- | ------- | -------------------------- |
 * | workspace row missing                                 | revoke  | `workspace_missing`        |
 * | workspace user or project differs from the token's    | revoke  | `identity_mismatch`        |
 * | workspace `deleted`                                   | revoke  | `workspace_deleted`        |
 * | credential generation retired                         | revoke  | `generation_retired`       |
 * | `users` row missing (account deleted)                 | revoke  | `user_missing`             |
 * | user `suspended` (an admin can unsuspend)             | reject  | `user_suspended`           |
 * | user status not `active`/`pending` (unrecognised)     | reject  | `user_status_unrecognized` |
 * | no `project_members` row for (project, user)          | revoke  | `membership_missing`       |
 * | membership `removed` (offboarded)                     | revoke  | `membership_removed`       |
 * | membership `invited` / `suspended` / other non-active | reject  | `membership_inactive`      |
 * | workspace stopping/stopped/sleeping/error/...         | reject  | `workspace_inactive`       |
 * | node missing, unassigned or ending                    | reject  | `node_inactive`            |
 *
 * User `pending` is accepted here: REST denies it only while signup approval is required
 * (`assertUserAllowedBySignupApproval`), and a pending account cannot start a workspace in
 * that mode. A NULL `users.status` (the column is `NOT NULL DEFAULT 'active'` in D1) is read
 * as `active`, the same coercion `resolveSessionStatus` applies to a session. The member's
 * ROLE is not checked here; tools that need a specific capability re-check it themselves
 * (`routes/mcp/orchestration-authority.ts`, `routes/project-deployment.ts`).
 *
 * A new runtime for the same workspace ID (Instant wake, VM restart or rebuild) rotates the
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
  /** `users.id` from the LEFT JOIN: NULL exactly when the owner's account row is gone. */
  joinedUserId: string | null;
  userStatus: string | null;
  /** `project_members.user_id` from the LEFT JOIN: NULL exactly when no membership row exists. */
  joinedMemberUserId: string | null;
  membershipStatus: string | null;
  status: string;
  nodeId: string | null;
  nodeStatus: string | null;
  callbackGeneration: string | null;
}

/** Why a token's workspace no longer authorizes it, or null when it does. */
type McpTokenWorkspaceVerdict = { reason: string; revoke: boolean } | null;

/** Account states that may act through an MCP token (see the module comment for `pending`). */
const MCP_ACCEPTED_USER_STATUSES: ReadonlySet<string> = new Set(['active', 'pending']);

function actorVerdict(row: McpTokenWorkspaceRow): McpTokenWorkspaceVerdict {
  if (row.joinedUserId === null) return { reason: 'user_missing', revoke: true };
  const userStatus = row.userStatus ?? 'active';
  // Recoverable: an admin can unsuspend, and the agent's token must work again when they do.
  if (userStatus === 'suspended') return { reason: 'user_suspended', revoke: false };
  if (!MCP_ACCEPTED_USER_STATUSES.has(userStatus)) {
    return { reason: 'user_status_unrecognized', revoke: false };
  }
  if (row.joinedMemberUserId === null) return { reason: 'membership_missing', revoke: true };
  if (row.membershipStatus === 'removed') return { reason: 'membership_removed', revoke: true };
  // `invited`, `suspended`, or anything else can still become active again.
  if (row.membershipStatus !== 'active') return { reason: 'membership_inactive', revoke: false };
  return null;
}

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
  const actor = actorVerdict(row);
  if (actor) return actor;
  if (!WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(row.status)) {
    return { reason: 'workspace_inactive', revoke: false };
  }
  if (!row.nodeId || !row.nodeStatus || nodeStatusTerminatesCallbacks(row.nodeStatus)) {
    return { reason: 'node_inactive', revoke: false };
  }
  return null;
}

/** Log value for a LEFT-JOINed status: `missing` when the joined row does not exist. */
function joinedStatus(
  joinedId: string | null | undefined,
  status: string | null | undefined
): string | null {
  if (joinedId === undefined) return null;
  return joinedId === null ? 'missing' : (status ?? null);
}

/**
 * Validate a workspace MCP token and require its workspace and actor to still authorize it.
 * Returns the token data, or null when the token is unknown, expired, or no longer
 * authorized (see the verdict table in the module comment).
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
                u.id AS joinedUserId,
                u.status AS userStatus,
                pm.user_id AS joinedMemberUserId,
                pm.status AS membershipStatus,
                w.status AS status,
                w.node_id AS nodeId,
                n.status AS nodeStatus,
                w.callback_generation AS callbackGeneration
           FROM workspaces w
           LEFT JOIN nodes n ON n.id = w.node_id
           LEFT JOIN users u ON u.id = w.user_id
           LEFT JOIN project_members pm
             ON pm.project_id = w.project_id
            AND pm.user_id = w.user_id
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
    userStatus: joinedStatus(row?.joinedUserId, row?.userStatus),
    membershipStatus: joinedStatus(row?.joinedMemberUserId, row?.membershipStatus),
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
