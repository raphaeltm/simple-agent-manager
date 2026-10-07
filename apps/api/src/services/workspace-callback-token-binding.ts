/**
 * Workspace callback token binding and control-plane delivery.
 *
 * A workspace callback token may only ever reach the VM node that D1 binds the
 * workspace to. This module reads that binding and mints the fresh token the
 * control plane delivers over the node-management channel (VM hibernate requests,
 * `node-agent-session-snapshots.ts`), exactly as workspace creation does.
 *
 * Renewal and delivery are VM-only (`isInstantRuntimeBinding`). An Instant
 * (cf-container) runtime gets a fresh token from its container DO on every cold wake,
 * one per container generation, and recovery replaces a generation under the same
 * nodeId. Renewing would let a superseded generation that is still running extend its
 * workspace authority past the lifetime of the token it was started with, and a
 * wall-clock token pushed to a generation would defeat the Instant stale-callback
 * guard (`routes/_stale-callback-guard.ts`).
 *
 * Kept free of route helpers so that the hibernate path stays lightweight; the
 * agent-initiated renewal route lives in `workspace-callback-token-renewal.ts`.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { signCallbackToken } from './jwt';
import { nodeStatusTerminatesCallbacks } from './node-callback-auth';
import {
  sameWorkspaceCallbackIdentity,
  WORKSPACE_CALLBACK_ACTIVE_STATUSES,
  type WorkspaceCallbackIdentitySnapshot,
} from './workspace-callback-identity';

export interface WorkspaceCallbackTokenBinding extends WorkspaceCallbackIdentitySnapshot {
  nodeUserId: string | null;
  nodeRuntime: string | null;
}

export async function loadWorkspaceCallbackTokenBinding(
  env: Env,
  workspaceId: string
): Promise<WorkspaceCallbackTokenBinding | null> {
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
    .first<WorkspaceCallbackTokenBinding>();
  return row ?? null;
}

/**
 * A workspace's callback authority belongs to the node D1 binds it to. Placement only
 * binds a workspace to a node owned by the workspace user, so a mismatch is a foreign
 * node and must not receive the workspace's credential.
 */
export function workspaceBoundToNode(
  binding: WorkspaceCallbackTokenBinding,
  nodeId: string
): boolean {
  return (
    !!binding.nodeId &&
    binding.nodeId === nodeId &&
    !!binding.nodeUserId &&
    binding.nodeUserId === binding.userId
  );
}

/** Instant (cf-container) workspaces neither renew nor receive tokens (see file header). */
export function isInstantRuntimeBinding(binding: WorkspaceCallbackTokenBinding): boolean {
  return binding.nodeRuntime === 'cf-container';
}

/**
 * Why a binding may not receive a delivered token, or null when it may.
 */
function deliverySkipReason(
  binding: WorkspaceCallbackTokenBinding | null,
  nodeId: string
): string | null {
  if (!binding) return 'workspace_missing';
  if (!workspaceBoundToNode(binding, nodeId)) return 'not_bound_to_node';
  if (isInstantRuntimeBinding(binding)) return 'instant_runtime';
  if (!WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(binding.status)) return 'workspace_inactive';
  if (!binding.nodeStatus || nodeStatusTerminatesCallbacks(binding.nodeStatus)) {
    return 'node_inactive';
  }
  return null;
}

function sameRenewalBinding(
  current: WorkspaceCallbackTokenBinding,
  expected: WorkspaceCallbackTokenBinding
) {
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
    const binding = await loadWorkspaceCallbackTokenBinding(env, input.workspaceId);
    const skipReason = deliverySkipReason(binding, input.nodeId);
    if (skipReason || !binding) return skip(skipReason ?? 'workspace_missing');

    const token = await signCallbackToken(input.workspaceId, env);

    const current = await loadWorkspaceCallbackTokenBinding(env, input.workspaceId);
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
