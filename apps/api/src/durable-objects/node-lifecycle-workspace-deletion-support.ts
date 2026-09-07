import {
  DEFAULT_WORKSPACE_DELETION_ALARM_BATCH_SIZE,
  DEFAULT_WORKSPACE_DELETION_MAX_RESIDENCE_MS,
  DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS,
  DEFAULT_WORKSPACE_DELETION_RETRY_MAX_MS,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import type {
  WorkspaceDeletionIdentity,
  WorkspaceDeletionMode,
} from '../services/workspace-deletion';

export type NodeLifecycleDeletionEnv = {
  DATABASE: D1Database;
  OBSERVABILITY_DATABASE: D1Database;
  WORKSPACE_STOPPED_TTL_MS?: string;
  WORKSPACE_DELETION_RETRY_BASE_MS?: string;
  WORKSPACE_DELETION_RETRY_MAX_MS?: string;
  WORKSPACE_DELETION_MAX_RESIDENCE_MS?: string;
  WORKSPACE_DELETION_ALARM_BATCH_SIZE?: string;
  WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH?: string;
  NODE_AGENT_BACKGROUND_REQUEST_TIMEOUT_MS?: string;
};

export interface PendingWorkspaceDeletion {
  nodeId?: string;
  nodeUserId?: string | null;
  nodeRuntime?: string | null;
  nodeProviderInstanceId?: string | null;
  nodeRuntimeIncarnationId?: string | null;
  workspaceId: string;
  userId: string;
  projectId?: string | null;
  chatSessionId?: string | null;
  deleteAt: number;
  firstScheduledAt?: number;
  attemptCount?: number;
  lastAttemptAt?: number | null;
  lastError?: string | null;
  claimId?: string | null;
  deadLetteredAt?: number | null;
  deadLetterReason?: string | null;
}

export type WorkspaceDeletionAttemptDispatcher = (attempt: Promise<void>) => void;

export type WorkspaceDeletionClaimResult = 'claimed' | 'already_claimed_same_identity' | 'fenced';

export function workspaceStoppedTtlMs(env: NodeLifecycleDeletionEnv): number {
  const parsed = Number.parseInt(env.WORKSPACE_STOPPED_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_STOPPED_TTL_MS;
}

export function workspaceDeletionRetryDelayMs(
  env: NodeLifecycleDeletionEnv,
  attemptCount: number
): number {
  const parsedBase = Number.parseInt(env.WORKSPACE_DELETION_RETRY_BASE_MS ?? '', 10);
  const baseMs =
    Number.isFinite(parsedBase) && parsedBase > 0
      ? parsedBase
      : DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS;
  const parsedMax = Number.parseInt(env.WORKSPACE_DELETION_RETRY_MAX_MS ?? '', 10);
  const maxMs =
    Number.isFinite(parsedMax) && parsedMax >= baseMs
      ? parsedMax
      : Math.max(baseMs, DEFAULT_WORKSPACE_DELETION_RETRY_MAX_MS);
  const exponent = Math.max(attemptCount - 1, 0);
  const saturationExponent = Math.ceil(Math.log2(maxMs / baseMs));
  if (exponent >= saturationExponent) return maxMs;
  return baseMs * 2 ** exponent;
}

export function workspaceDeletionAlarmBatchSize(env: NodeLifecycleDeletionEnv): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_ALARM_BATCH_SIZE ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_ALARM_BATCH_SIZE;
}

export function workspaceDeletionMaxResidenceMs(env: NodeLifecycleDeletionEnv): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_MAX_RESIDENCE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_MAX_RESIDENCE_MS;
}

export async function claimWorkspaceDeletionInD1(
  env: NodeLifecycleDeletionEnv,
  expected: WorkspaceDeletionIdentity,
  attempt: number,
  diagnostic: string,
  mode: WorkspaceDeletionMode
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
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM nodes n
             WHERE n.id = workspaces.node_id
               AND n.user_id IS ?
               AND n.runtime IS ?
               AND n.provider_instance_id IS ?
               AND n.runtime_incarnation_id IS ?
          )
        )
        AND runtime_deletion_confirmed_at IS NULL
        ${statusPredicate}`
  )
    .bind(
      diagnostic,
      new Date().toISOString(),
      expected.workspaceId,
      expected.userId,
      expected.projectId,
      expected.chatSessionId,
      expected.nodeId,
      expected.nodeId,
      expected.nodeUserId,
      expected.nodeRuntime,
      expected.nodeProviderInstanceId,
      expected.nodeRuntimeIncarnationId
    )
    .run();
  if ((result.meta.changes ?? 0) > 0) return true;

  log.warn('node_lifecycle.workspace_deletion_claim_fenced', {
    workspaceId: expected.workspaceId,
    nodeId: expected.nodeId,
    userId: expected.userId,
    attempt,
    action: 'network_request_refused',
  });
  return false;
}
