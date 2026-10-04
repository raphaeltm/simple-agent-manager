/**
 * Workspace callback token renewal.
 *
 * Workspace-scoped callback JWTs (`signCallbackToken`) expire after
 * CALLBACK_TOKEN_EXPIRY_MS (default 24h), but a workspace can stay awake longer. Two
 * existing trusted channels keep the VM agent's copy fresh without widening the
 * authority of any credential:
 *
 * 1. Proof-of-possession renewal (VM agent -> API, `renewWorkspaceCallbackToken`): the
 *    agent presents the workspace's CURRENT, unexpired token (Authorization header) AND
 *    its own node-scoped token (JSON body, which Workers Logs never records). Neither
 *    credential alone is enough, the same dual-credential rule as the snapshot upload
 *    relay (`verifySessionSnapshotRelayAuthorization`). A node token cannot mint a
 *    workspace token, a workspace token copied out of a devcontainer cannot renew
 *    itself, and an expired token is never renewed.
 * 2. Control-plane delivery (API -> VM agent, `mintWorkspaceCallbackTokenForNodeDelivery`):
 *    requests the control plane already sends over the node-management channel to a VM
 *    node carry a freshly minted token, exactly as workspace create does. Instant
 *    (cf-container) runtimes are excluded: their container DO mints a fresh token on every
 *    cold wake, and a wall-clock token pushed to a container generation would defeat the
 *    Instant stale-callback guard (`routes/_stale-callback-guard.ts`).
 *
 * Both paths renew only while D1 says the workspace is active and bound to the node, so
 * deleting, stopping or reassigning a workspace still ends its callback authority.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { AppError, errors } from '../middleware/error';
import {
  assertWorkspaceAcceptsCallback,
  assertWorkspaceCallbackIdentityCurrent,
  sameWorkspaceCallbackIdentity,
  WORKSPACE_CALLBACK_ACTIVE_STATUSES,
  type WorkspaceCallbackIdentitySnapshot,
} from '../routes/workspaces/_helpers';
import {
  callbackTokenExpiresAtMs,
  callbackTokenGenerationIssuedAtSeconds,
} from './callback-token-claims';
import { shouldRefreshCallbackToken, signCallbackToken, verifyCallbackToken } from './jwt';
import { nodeStatusTerminatesCallbacks } from './node-callback-auth';

/**
 * Error codes for the node credential, distinct from the workspace credential's
 * UNAUTHORIZED/FORBIDDEN. The agent retries a node-credential failure after its node
 * token refreshes, but stops presenting a workspace token the API rejected.
 */
export const NODE_CALLBACK_UNAUTHORIZED = 'NODE_CALLBACK_UNAUTHORIZED';
export const NODE_CALLBACK_FORBIDDEN = 'NODE_CALLBACK_FORBIDDEN';

interface WorkspaceRenewalBinding extends WorkspaceCallbackIdentitySnapshot {
  nodeUserId: string | null;
  nodeRuntime: string | null;
}

export type WorkspaceCallbackTokenRenewalResult =
  { renewed: true; token: string; expiresAt: string | null } | { renewed: false };

async function loadWorkspaceRenewalBinding(
  env: Env,
  workspaceId: string
): Promise<WorkspaceRenewalBinding | null> {
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspaceId,
            w.user_id AS userId,
            w.project_id AS projectId,
            w.chat_session_id AS chatSessionId,
            w.status AS status,
            w.node_id AS nodeId,
            n.status AS nodeStatus,
            n.user_id AS nodeUserId,
            n.runtime AS nodeRuntime
       FROM workspaces w
       LEFT JOIN nodes n ON n.id = w.node_id
      WHERE w.id = ?
      LIMIT 1`
  )
    .bind(workspaceId)
    .first<WorkspaceRenewalBinding>();
  return row ?? null;
}

/**
 * A workspace's callback authority belongs to the node D1 binds it to. Placement only
 * binds a workspace to a node owned by the workspace user, so a mismatch is a foreign
 * node and must not receive the workspace's credential.
 */
function workspaceBoundToNode(binding: WorkspaceRenewalBinding, nodeId: string): boolean {
  return (
    !!binding.nodeId &&
    binding.nodeId === nodeId &&
    !!binding.nodeUserId &&
    binding.nodeUserId === binding.userId
  );
}

async function verifyRenewalNodeCredential(
  env: Env,
  nodeId: string,
  nodeToken: string
): Promise<void> {
  if (!nodeId || !nodeToken) {
    throw new AppError(401, NODE_CALLBACK_UNAUTHORIZED, 'Node callback credential required');
  }
  try {
    const payload = await verifyCallbackToken(nodeToken, env, { expectedScope: 'node' });
    if (payload.workspace !== nodeId) {
      throw new AppError(403, NODE_CALLBACK_FORBIDDEN, 'Node callback token does not match node');
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.error === NODE_CALLBACK_FORBIDDEN) throw err;
    if (err.statusCode === 401) {
      throw new AppError(401, NODE_CALLBACK_UNAUTHORIZED, 'Invalid or expired node callback token');
    }
    throw new AppError(403, NODE_CALLBACK_FORBIDDEN, 'Insufficient node token scope');
  }
}

/**
 * Renew a workspace callback token for the agent on the node hosting the workspace.
 *
 * Returns `{ renewed: false }` while the presented token is younger than the shared
 * CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO, so a holder cannot mint early. Throws designed
 * 401/403/410 AppErrors; never a 5xx for a rejected credential.
 */
export async function renewWorkspaceCallbackToken(
  env: Env,
  input: {
    workspaceId: string;
    workspaceToken: string;
    nodeId: string;
    nodeToken: string;
  }
): Promise<WorkspaceCallbackTokenRenewalResult> {
  const { workspaceId, workspaceToken, nodeId } = input;

  // Both credentials are verified before any read, so neither alone can probe state.
  const workspacePayload = await verifyCallbackToken(workspaceToken, env, {
    expectedScope: 'workspace',
  });
  if (workspacePayload.workspace !== workspaceId) {
    throw errors.forbidden('Callback token does not match workspace');
  }
  await verifyRenewalNodeCredential(env, nodeId, input.nodeToken);

  const binding = await loadWorkspaceRenewalBinding(env, workspaceId);
  if (binding && !workspaceBoundToNode(binding, nodeId)) {
    log.warn('workspace_callback_token.renewal_rejected', {
      workspaceId,
      nodeId,
      boundNodeId: binding.nodeId,
      reason: 'not_bound_to_node',
      action: 'rejected',
    });
    throw errors.forbidden('Workspace is not hosted on this node');
  }
  const active = await assertWorkspaceAcceptsCallback(
    env,
    binding,
    workspaceId,
    'callback_token_renewal'
  );

  if (!shouldRefreshCallbackToken(workspaceToken, env)) {
    return { renewed: false };
  }

  const generationIssuedAtSeconds = callbackTokenGenerationIssuedAtSeconds(workspaceToken);
  const token = await signCallbackToken(workspaceId, env, {
    generationIssuedAtSeconds: generationIssuedAtSeconds ?? undefined,
  });

  // Rule 49: re-read the workspace incarnation at the secret-delivery boundary, so a
  // deletion or reassignment that won while minting suppresses the new credential.
  await assertWorkspaceCallbackIdentityCurrent(env, active, 'callback_token_renewal');

  const expiresAtMs = callbackTokenExpiresAtMs(token);
  log.info('workspace_callback_token.renewed', {
    workspaceId,
    nodeId,
    generationAgeSeconds:
      generationIssuedAtSeconds === null
        ? null
        : Math.max(0, Math.floor(Date.now() / 1000) - generationIssuedAtSeconds),
  });
  return {
    renewed: true,
    token,
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Why a binding may not receive a delivered token, or null when it may. Delivery is
 * VM-only (see the file header for why Instant runtimes are excluded).
 */
function deliverySkipReason(
  binding: WorkspaceRenewalBinding | null,
  nodeId: string
): string | null {
  if (!binding) return 'workspace_missing';
  if (!workspaceBoundToNode(binding, nodeId)) return 'not_bound_to_node';
  if (binding.nodeRuntime === 'cf-container') return 'instant_runtime';
  if (!WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(binding.status)) return 'workspace_inactive';
  if (!binding.nodeStatus || nodeStatusTerminatesCallbacks(binding.nodeStatus)) {
    return 'node_inactive';
  }
  return null;
}

function sameRenewalBinding(current: WorkspaceRenewalBinding, expected: WorkspaceRenewalBinding) {
  return (
    sameWorkspaceCallbackIdentity(current, expected) &&
    current.nodeUserId === expected.nodeUserId &&
    current.nodeRuntime === expected.nodeRuntime
  );
}

/**
 * Mint a fresh workspace callback token for a control-plane request that is about to be
 * delivered to `nodeId` over the node-management channel. Returns null, and the caller
 * sends its request without a token exactly as before, unless D1 binds the workspace to
 * that VM node and the workspace and node are still active, both before and after
 * signing (rule 49), so a delete or move that wins the race gets no credential.
 */
export async function mintWorkspaceCallbackTokenForNodeDelivery(
  env: Env,
  input: { workspaceId: string; nodeId: string }
): Promise<string | null> {
  const skip = (reason: string) => {
    log.info('workspace_callback_token.delivery_skipped', {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      reason,
    });
    return null;
  };
  try {
    const binding = await loadWorkspaceRenewalBinding(env, input.workspaceId);
    const skipReason = deliverySkipReason(binding, input.nodeId);
    if (skipReason || !binding) return skip(skipReason ?? 'workspace_missing');

    const token = await signCallbackToken(input.workspaceId, env);

    const current = await loadWorkspaceRenewalBinding(env, input.workspaceId);
    if (!current || !sameRenewalBinding(current, binding)) {
      return skip('incarnation_changed');
    }
    return token;
  } catch (err) {
    log.warn('workspace_callback_token.delivery_mint_failed', {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
