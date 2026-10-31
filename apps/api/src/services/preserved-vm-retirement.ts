import { DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { verifyVmFallbackRetirement } from './preserved-vm-fallback';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';
import { automaticDeletionPreservationExpiresAt } from './workspace-deletion-preservation';

export interface PreservedVmRetirementBudget {
  remainingSources: number;
  exhausted?: boolean;
}

export interface PreservedVmRetirement {
  sourcesJson: string;
  runtimeIncarnationId: string;
  providerInstanceId: string;
  beforeDestroy: () => Promise<void>;
}

/** Exact sources verified by the caller; one JSON binding keeps D1 parameter use bounded. */
export function preservedVmSourceSql(workspace: string, node: string): string {
  return `EXISTS (
    SELECT 1 FROM json_each(?) approved
    JOIN session_snapshots saved ON saved.workspace_id = ${workspace}.id
      AND saved.chat_session_id IS ${workspace}.chat_session_id
      AND saved.project_id IS ${workspace}.project_id
      AND saved.user_id IS ${node}.user_id AND saved.node_id IS ${node}.id
    WHERE ${node}.runtime = 'vm' AND ${node}.node_class = 'managed'
      AND ${node}.node_role = 'workspace'
      AND ${workspace}.user_id IS ${node}.user_id AND ${workspace}.node_id IS ${node}.id
      AND ${workspace}.status IN ('stopping', 'stopped', 'sleeping', 'evicted')
      AND ${workspace}.id IS json_extract(approved.value, '$.workspaceId')
      AND ${workspace}.eviction_generation IS json_extract(approved.value, '$.workspaceGeneration')
      AND ${node}.runtime_incarnation_id IS json_extract(approved.value, '$.runtimeIncarnationId')
      AND ${node}.provider_instance_id IS json_extract(approved.value, '$.providerInstanceId')
      AND saved.snapshot_generation IS json_extract(approved.value, '$.snapshotGeneration')
      AND saved.capture_generation IS NULL
      AND saved.expires_at IS json_extract(approved.value, '$.expiresAt')
      AND saved.cleanup_identity_json IS json_extract(approved.value, '$.cleanupIdentityJson')
      AND ((json_extract(approved.value, '$.kind') = 'snapshot'
        AND saved.status = 'available' AND saved.degradation = 'none'
        AND saved.sleep_status = 'sleeping'
        AND julianday(saved.expires_at) > julianday('now'))
      OR (json_extract(approved.value, '$.kind') = 'fallback'
        AND saved.sleep_status IS json_extract(approved.value, '$.sleepStatus')
        AND saved.sleep_claim_id IS json_extract(approved.value, '$.sleepClaimId')
        AND saved.sleep_fallback_json IS json_extract(approved.value, '$.fallbackJson')
        AND saved.recovery_status IS json_extract(approved.value, '$.recoveryStatus')
        AND saved.recovery_attempt_id IS json_extract(approved.value, '$.recoveryAttemptId')
        AND saved.recovery_workspace_id IS json_extract(approved.value, '$.recoveryWorkspaceId')))
  )`;
}

/**
 * A legacy VM agent may lack physical-deletion confirmation. Whole-VM retirement is
 * safe only for exact saved sleep sources or durable bounded-fallback decisions.
 * Complete sources verify R2; fallback sources verify the retained transcript.
 * This is preservation authority, never proof that the old runtime has disappeared.
 */
export async function preparePreservedVmRetirement(
  env: Env,
  nodeId: string,
  userId: string,
  budget?: PreservedVmRetirementBudget
): Promise<PreservedVmRetirement | undefined> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, nodeId), eq(schema.nodes.userId, userId)))
    .get();
  if (
    !node ||
    node.runtime !== 'vm' ||
    node.nodeClass !== 'managed' ||
    node.nodeRole !== 'workspace' ||
    !node.runtimeIncarnationId ||
    !node.providerInstanceId
  )
    return undefined;
  const configuredLimit = parsePositiveInt(
    env.WORKSPACE_CLEANUP_SWEEP_LIMIT,
    DEFAULT_WORKSPACE_CLEANUP_SWEEP_LIMIT
  );
  const limit = Math.min(configuredLimit, budget?.remainingSources ?? configuredLimit);
  if (limit <= 0) return undefined;
  const workspaces = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.nodeId, nodeId))
    .limit(limit + 1);
  if (workspaces.length > limit) {
    if (budget && limit < configuredLimit) {
      budget.exhausted = true;
      budget.remainingSources = 0;
    }
    return undefined;
  }
  if (budget) budget.remainingSources -= workspaces.length;
  const sources: Array<
    WorkspaceDeletionIdentity & {
      runtimeIncarnationId: string;
      providerInstanceId: string;
      snapshotGeneration: string | null;
      expiresAt: string;
      kind: 'snapshot' | 'fallback';
      cleanupIdentityJson: string | null;
      sleepStatus: string | null;
      sleepClaimId: string | null;
      fallbackJson: string | null;
      recoveryStatus: string | null;
      recoveryAttemptId: string | null;
      recoveryWorkspaceId: string | null;
    }
  > = [];
  for (const workspace of workspaces) {
    if (
      workspace.userId !== userId ||
      ['running', 'creating', 'recovery'].includes(workspace.status)
    )
      return undefined;
    if (
      workspace.runtimeDeletionConfirmedAt &&
      ['vm_agent_confirmed', 'workspace_never_started', 'node_runtime_terminated'].includes(
        workspace.runtimeDeletionProof ?? ''
      )
    )
      continue;
    if (!['stopping', 'stopped', 'sleeping', 'evicted'].includes(workspace.status))
      return undefined;
    const snapshot = await db
      .select()
      .from(schema.sessionSnapshots)
      .where(eq(schema.sessionSnapshots.workspaceId, workspace.id))
      .get();
    if (!snapshot) return undefined;
    const identity = {
      workspaceId: workspace.id,
      workspaceGeneration: workspace.evictionGeneration,
      nodeId,
      nodeUserId: userId,
      nodeRuntime: node.runtime,
      nodeProviderInstanceId: node.providerInstanceId,
      nodeRuntimeIncarnationId: node.runtimeIncarnationId,
      userId,
      projectId: workspace.projectId,
      chatSessionId: workspace.chatSessionId,
    };
    const expiresAt = await automaticDeletionPreservationExpiresAt(env, identity, 'vm_retirement');
    const kind = expiresAt ? 'snapshot' : 'fallback';
    if (!expiresAt && !(await verifyVmFallbackRetirement(env, identity, snapshot)))
      return undefined;
    sources.push({
      ...identity,
      runtimeIncarnationId: node.runtimeIncarnationId,
      providerInstanceId: node.providerInstanceId,
      snapshotGeneration: snapshot.snapshotGeneration,
      expiresAt: expiresAt ?? snapshot.expiresAt,
      kind,
      cleanupIdentityJson: snapshot.cleanupIdentityJson,
      sleepStatus: snapshot.sleepStatus,
      sleepClaimId: snapshot.sleepClaimId,
      fallbackJson: snapshot.sleepFallbackJson,
      recoveryStatus: snapshot.recoveryStatus,
      recoveryAttemptId: snapshot.recoveryAttemptId,
      recoveryWorkspaceId: snapshot.recoveryWorkspaceId,
    });
  }
  if (!sources.length) return undefined;
  const sourcesJson = JSON.stringify(sources);
  return {
    sourcesJson,
    runtimeIncarnationId: node.runtimeIncarnationId,
    providerInstanceId: node.providerInstanceId,
    async beforeDestroy() {
      for (const source of sources) {
        if (source.kind === 'snapshot') {
          if (
            (await automaticDeletionPreservationExpiresAt(env, source, 'vm_retirement')) !==
            source.expiresAt
          )
            throw new Error('VM retirement preservation is no longer available');
        } else {
          const snapshot = await db
            .select()
            .from(schema.sessionSnapshots)
            .where(eq(schema.sessionSnapshots.workspaceId, source.workspaceId))
            .get();
          if (
            !snapshot ||
            snapshot.sleepFallbackJson !== source.fallbackJson ||
            snapshot.cleanupIdentityJson !== source.cleanupIdentityJson ||
            !(await verifyVmFallbackRetirement(env, source, snapshot))
          )
            throw new Error('VM retirement fallback is no longer available');
        }
      }
    },
  };
}

/** Cleanup retry bookkeeping is not user activity; completed sleep owns this clock. */
export function preservedVmRetirementActivitySql(workspace: string): string {
  return `COALESCE((SELECT COALESCE(slept.sleeping_at, slept.sleep_stopping_since, slept.updated_at) FROM session_snapshots slept
    WHERE slept.workspace_id = ${workspace}.id AND slept.node_id IS ${workspace}.node_id
      AND slept.user_id IS ${workspace}.user_id AND slept.chat_session_id IS ${workspace}.chat_session_id
      AND slept.project_id IS ${workspace}.project_id AND slept.sleep_status IN ('sleeping', 'stopping')
      AND ${workspace}.status IN ('stopping', 'stopped', 'sleeping', 'evicted')
    LIMIT 1), CASE WHEN ${workspace}.status IN ('stopping', 'stopped', 'sleeping', 'evicted')
      THEN COALESCE(${workspace}.stop_runtime_confirmed_at, ${workspace}.last_activity_at, ${workspace}.created_at)
      ELSE ${workspace}.updated_at END)`;
}
