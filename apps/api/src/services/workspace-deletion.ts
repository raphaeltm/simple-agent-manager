import { DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteWorkspaceOnNode, NodeAgentHttpError } from './node-agent';
import { finalizeWorkspaceLifecycleClosure } from './workspace-lifecycle-finalizer';

export const WORKSPACE_DELETION_DIAGNOSTIC_PREFIX = 'Workspace deletion unconfirmed';

export interface WorkspaceDeletionIdentity {
  workspaceId: string;
  nodeId: string | null;
  userId: string;
  projectId: string | null;
  chatSessionId: string | null;
}

export interface WorkspaceDeletionSnapshot extends WorkspaceDeletionIdentity {
  status: string;
}

export type WorkspaceDeletionProof =
  | 'vm_agent_confirmed'
  | 'workspace_never_started'
  | 'node_runtime_terminated';

export type WorkspaceDeletionOutcome =
  | {
      status: 'confirmed';
      proof: WorkspaceDeletionProof;
      workspaceFinalized: boolean;
    }
  | {
      status: 'retry';
      reason: string;
      diagnostic: string;
    }
  | {
      status: 'fenced';
      reason: 'workspace_active' | 'workspace_missing' | 'workspace_assignment_changed';
    };

type WorkspaceDeletionRow = WorkspaceDeletionSnapshot;

interface AttemptWorkspaceDeletionOptions {
  env: Env;
  expected: WorkspaceDeletionIdentity;
  attempt: number;
  source: string;
  mode: 'automatic' | 'explicit';
  requestTimeoutMs?: number;
  beforeFinalize?: () => Promise<void>;
}

function nullableEqual(left: string | null, right: string | null): boolean {
  return left === right;
}

function sameOwnership(
  current: WorkspaceDeletionIdentity,
  expected: WorkspaceDeletionIdentity
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    current.userId === expected.userId &&
    nullableEqual(current.projectId, expected.projectId) &&
    nullableEqual(current.chatSessionId, expected.chatSessionId) &&
    nullableEqual(current.nodeId, expected.nodeId)
  );
}

function sameOwnershipExceptTerminalNode(
  current: WorkspaceDeletionIdentity,
  expected: WorkspaceDeletionIdentity
): boolean {
  return (
    current.workspaceId === expected.workspaceId &&
    current.userId === expected.userId &&
    nullableEqual(current.projectId, expected.projectId) &&
    nullableEqual(current.chatSessionId, expected.chatSessionId) &&
    (nullableEqual(current.nodeId, expected.nodeId) || current.nodeId === null)
  );
}

function diagnosticMaxLength(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH;
}

function boundedDiagnostic(env: Env, value: string): string {
  const sanitized = value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.slice(0, diagnosticMaxLength(env));
}

function deletionFailureDiagnostic(env: Env, attempt: number, error: unknown): string {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/(?:HTTP|status)\s+(\d{3})/i);
  const category = /timeout|timed out|abort/i.test(`${errorName} ${message}`)
    ? 'request_timeout'
    : statusMatch?.[1]
      ? `http_status_${statusMatch[1]}`
      : 'request_failed';
  return boundedDiagnostic(
    env,
    `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: VM attempt ${attempt} (${errorName}: ${category})`
  );
}

async function loadWorkspaceDeletionRow(
  database: D1Database,
  workspaceId: string
): Promise<WorkspaceDeletionRow | null> {
  const row = await database
    .prepare(
      `SELECT w.id AS workspaceId,
              w.node_id AS nodeId,
              w.user_id AS userId,
              w.project_id AS projectId,
              w.chat_session_id AS chatSessionId,
              w.status AS status
         FROM workspaces w
        WHERE w.id = ?
        LIMIT 1`
    )
    .bind(workspaceId)
    .first<WorkspaceDeletionRow>();
  return row ?? null;
}

async function terminalNodeProof(
  database: D1Database,
  expected: WorkspaceDeletionIdentity
): Promise<WorkspaceDeletionProof | null> {
  if (!expected.nodeId) return null;
  // Ownership disagreement and node status labels are not terminal proof.
  // Only strict provider/container teardown writes this marker; legacy paths
  // may mark a node deleted even when the provider request failed.
  const node = await database
    .prepare(
      'SELECT runtime_termination_confirmed_at AS runtimeTerminationConfirmedAt FROM nodes WHERE id = ? LIMIT 1'
    )
    .bind(expected.nodeId)
    .first<{ runtimeTerminationConfirmedAt: string | null }>();
  return node?.runtimeTerminationConfirmedAt ? 'node_runtime_terminated' : null;
}

async function persistDeletionDiagnostic(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  diagnostic: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE workspaces
          SET status = 'stopping', error_message = ?, updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND project_id IS ?
          AND chat_session_id IS ?
          AND node_id IS ?`
  )
    .bind(
      boundedDiagnostic(env, diagnostic),
      new Date().toISOString(),
      expected.workspaceId,
      expected.userId,
      expected.projectId,
      expected.chatSessionId,
      expected.nodeId
    )
    .run();
}

async function claimDeletionTransition(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  mode: AttemptWorkspaceDeletionOptions['mode'],
  attempt: number
): Promise<boolean> {
  const statusPredicate =
    mode === 'automatic' ? "AND status IN ('stopped', 'sleeping', 'stopping', 'deleted')" : '';
  const result = await env.DATABASE.prepare(
    `UPDATE workspaces
          SET status = 'stopping', error_message = ?, updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND project_id IS ?
          AND chat_session_id IS ?
          AND node_id IS ?
          ${statusPredicate}`
  )
    .bind(
      boundedDiagnostic(
        env,
        `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: awaiting VM confirmation (attempt ${attempt})`
      ),
      new Date().toISOString(),
      expected.workspaceId,
      expected.userId,
      expected.projectId,
      expected.chatSessionId,
      expected.nodeId
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function finalizeConfirmedDeletion(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  proof: WorkspaceDeletionProof,
  source: string,
  beforeFinalize?: () => Promise<void>
): Promise<WorkspaceDeletionOutcome> {
  const current = await loadWorkspaceDeletionRow(env.DATABASE, expected.workspaceId);
  if (!current) {
    return { status: 'confirmed', proof, workspaceFinalized: false };
  }

  const terminalNodeMayClearAssignment =
    proof === 'node_runtime_terminated' || proof === 'workspace_never_started';
  const ownershipMatches = terminalNodeMayClearAssignment
    ? sameOwnershipExceptTerminalNode(current, expected)
    : sameOwnership(current, expected);
  if (!ownershipMatches) {
    log.warn('workspace_deletion.confirmed_old_incarnation', {
      workspaceId: expected.workspaceId,
      expectedNodeId: expected.nodeId,
      currentNodeId: current.nodeId,
      proof,
      source,
      action: 'current_incarnation_preserved',
    });
    return { status: 'confirmed', proof, workspaceFinalized: false };
  }
  if (proof === 'vm_agent_confirmed' && current.status !== 'stopping') {
    log.warn('workspace_deletion.confirmed_after_state_change', {
      workspaceId: expected.workspaceId,
      expectedNodeId: expected.nodeId,
      currentStatus: current.status,
      source,
      action: 'current_state_preserved',
    });
    return { status: 'confirmed', proof, workspaceFinalized: false };
  }

  const result = await env.DATABASE.prepare(
    `UPDATE workspaces
        SET status = 'deleted', error_message = NULL, updated_at = ?
      WHERE id = ?
        AND user_id = ?
        AND project_id IS ?
        AND chat_session_id IS ?
        AND node_id IS ?
        AND status = ?`
  )
    .bind(
      new Date().toISOString(),
      current.workspaceId,
      current.userId,
      current.projectId,
      current.chatSessionId,
      current.nodeId,
      current.status
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return { status: 'confirmed', proof, workspaceFinalized: false };
  }

  await beforeFinalize?.();
  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: [expected.workspaceId],
    userId: expected.userId,
    agentSessionStatus: 'completed',
    reason: `workspace_deletion_${source}_${proof}`,
  });

  log.info('workspace_deletion.confirmed', {
    workspaceId: expected.workspaceId,
    nodeId: expected.nodeId,
    userId: expected.userId,
    proof,
    source,
  });
  return { status: 'confirmed', proof, workspaceFinalized: true };
}

/**
 * Delete one exact workspace incarnation and classify the evidence. A transport
 * timeout is deliberately a retry outcome: it says nothing about whether the
 * remote handler completed after the client stopped waiting.
 */
export async function attemptWorkspaceDeletion(
  options: AttemptWorkspaceDeletionOptions
): Promise<WorkspaceDeletionOutcome> {
  const { env, expected, attempt, source, mode, requestTimeoutMs, beforeFinalize } = options;
  const initial = await loadWorkspaceDeletionRow(env.DATABASE, expected.workspaceId);
  const proofBeforeRequest = await terminalNodeProof(env.DATABASE, expected);

  if (!initial) {
    return proofBeforeRequest
      ? finalizeConfirmedDeletion(env, expected, proofBeforeRequest, source, beforeFinalize)
      : { status: 'fenced', reason: 'workspace_missing' };
  }
  if (!sameOwnership(initial, expected)) {
    return proofBeforeRequest
      ? finalizeConfirmedDeletion(env, expected, proofBeforeRequest, source, beforeFinalize)
      : { status: 'fenced', reason: 'workspace_assignment_changed' };
  }
  if (!expected.nodeId && initial.status === 'pending') {
    return finalizeConfirmedDeletion(
      env,
      expected,
      'workspace_never_started',
      source,
      beforeFinalize
    );
  }
  if (proofBeforeRequest) {
    return finalizeConfirmedDeletion(env, expected, proofBeforeRequest, source, beforeFinalize);
  }

  const claimed = await claimDeletionTransition(env, expected, mode, attempt);
  if (!claimed) {
    const current = await loadWorkspaceDeletionRow(env.DATABASE, expected.workspaceId);
    if (current && sameOwnership(current, expected)) {
      return { status: 'fenced', reason: 'workspace_active' };
    }
    return { status: 'fenced', reason: 'workspace_assignment_changed' };
  }

  // Rule 49 / TOCTOU fence: re-read immediately before the external mutation.
  const beforeRequest = await loadWorkspaceDeletionRow(env.DATABASE, expected.workspaceId);
  if (
    !beforeRequest ||
    !sameOwnership(beforeRequest, expected) ||
    beforeRequest.status !== 'stopping'
  ) {
    return { status: 'fenced', reason: 'workspace_assignment_changed' };
  }

  try {
    let proof: WorkspaceDeletionProof;
    if (!expected.nodeId) {
      const diagnostic = boundedDiagnostic(
        env,
        `Runtime deletion unconfirmed after attempt ${attempt} (node assignment unavailable)`
      );
      await persistDeletionDiagnostic(env, expected, diagnostic);
      return { status: 'retry', reason: 'runtime_deletion_unconfirmed', diagnostic };
    } else {
      try {
        await deleteWorkspaceOnNode(expected.nodeId, expected.workspaceId, env, expected.userId, {
          requestTimeoutMs,
        });
      } catch (error) {
        // The VM agent's workspace-specific 404 means the exact runtime is
        // already absent and is therefore an idempotent deletion confirmation.
        // DNS loop-back 404s are converted to a different error in node-agent.
        if (!(error instanceof NodeAgentHttpError) || error.statusCode !== 404) throw error;
      }
      proof = 'vm_agent_confirmed';
    }
    return finalizeConfirmedDeletion(env, expected, proof, source, beforeFinalize);
  } catch (error) {
    // The node can become authoritatively terminal while the request is in
    // flight. That is valid proof; heartbeat age and health are intentionally
    // ignored here.
    const proofAfterError = await terminalNodeProof(env.DATABASE, expected);
    if (proofAfterError) {
      return finalizeConfirmedDeletion(env, expected, proofAfterError, source, beforeFinalize);
    }

    const diagnostic = deletionFailureDiagnostic(env, attempt, error);
    await persistDeletionDiagnostic(env, expected, diagnostic);
    log.warn('workspace_deletion.unconfirmed', {
      workspaceId: expected.workspaceId,
      nodeId: expected.nodeId,
      userId: expected.userId,
      attempt,
      source,
      diagnostic,
      action: 'retry',
    });
    return { status: 'retry', reason: 'runtime_deletion_unconfirmed', diagnostic };
  }
}

export async function loadWorkspaceDeletionSnapshot(
  database: D1Database,
  workspaceId: string
): Promise<WorkspaceDeletionSnapshot | null> {
  const workspace = await loadWorkspaceDeletionRow(database, workspaceId);
  if (!workspace) return null;
  return {
    workspaceId: workspace.workspaceId,
    nodeId: workspace.nodeId,
    userId: workspace.userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
    status: workspace.status,
  };
}

export async function loadWorkspaceDeletionIdentity(
  database: D1Database,
  workspaceId: string
): Promise<WorkspaceDeletionIdentity | null> {
  const workspace = await loadWorkspaceDeletionRow(database, workspaceId);
  if (!workspace) return null;
  return {
    workspaceId: workspace.workspaceId,
    nodeId: workspace.nodeId,
    userId: workspace.userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
  };
}
