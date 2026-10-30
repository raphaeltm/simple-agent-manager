/** Atomic cleanup claim and release; all destructive guard predicates stay together. */
import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import type { BoundedStrandedRetirement } from '../../services/bounded-stranded-retirement-authority';
import { cleanupNodeProvenanceSql } from '../../services/node-teardown-provenance';
import { workspaceArtifactsRetirementGuardSql } from '../../services/node-workspace-retirement-guard';
import {
  type PreservedVmRetirement,
  preservedVmRetirementActivitySql,
} from '../../services/preserved-vm-retirement';
import { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';
import { parseMs } from './config';
type CleanupNode = { id: string; user_id: string; status: string };

/** Sleeping Instant compute is the only wake target; snapshot retention owns teardown. */
export function sleepingContainerRetentionGuardSql(nodeAlias: string): string {
  return `AND NOT (${nodeAlias}.runtime = 'cf-container' AND EXISTS (
    SELECT 1 FROM workspaces retained_workspace
    WHERE retained_workspace.node_id = ${nodeAlias}.id
      AND retained_workspace.status = 'sleeping'
  ))`;
}

export async function claimNodeForCleanup(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  options: {
    preservedVm?: PreservedVmRetirement;
    boundedStrandedRetirement?: BoundedStrandedRetirement;
    allowActiveWorkspaces?: boolean;
    allowManagedRunningProvenance?: boolean;
    expectedLastHeartbeatAt?: string | null;
    requireWorkspaceIdle?: boolean;
    workspaceIdleThresholdIso?: string;
  } = {}
): Promise<boolean> {
  const workspaceIdleThresholdIso =
    options.workspaceIdleThresholdIso ??
    new Date(
      new Date(nowIso).getTime() -
        parseMs(
          env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
          DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
        )
    ).toISOString();
  const activeWorkspaceGuard = options.allowActiveWorkspaces
    ? ''
    : `AND NOT EXISTS (
         SELECT 1
         FROM workspaces active_workspace
         WHERE active_workspace.node_id = nodes.id
           AND active_workspace.status IN ('running', 'creating', 'recovery')
       )`;
  const workspaceIdleGuard =
    options.requireWorkspaceIdle === false
      ? ''
      : `AND (
         SELECT COALESCE(MAX(${options.preservedVm || ['stopped', 'destroying'].includes(node.status) ? preservedVmRetirementActivitySql('workspace_activity') : 'workspace_activity.updated_at'}), nodes.created_at)
         FROM workspaces workspace_activity
         WHERE workspace_activity.node_id = nodes.id
       ) < ?`;
  const result = await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = 'destroying', cleanup_blocked_since = NULL, cleanup_blocked_reason = NULL, updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND status = ?
       AND node_role = 'workspace'
       AND node_class != 'user-owned'
       AND (cleanup_backoff_until IS NULL OR cleanup_backoff_until <= ?)
       ${options.expectedLastHeartbeatAt === undefined ? '' : 'AND last_heartbeat_at IS ?'}
       AND ${cleanupNodeProvenanceSql('nodes', options.allowManagedRunningProvenance)}
       ${
         options.boundedStrandedRetirement
           ? `AND runtime = 'vm' AND node_class = 'managed' AND node_role = 'workspace'
         AND provider_instance_id IS ? AND runtime_incarnation_id IS ?`
           : `AND (runtime_termination_confirmed_at IS NOT NULL OR (1=1
         ${workspaceArtifactsRetirementGuardSql('nodes', false, !!options.preservedVm)}))`
       }
       ${activeWorkspaceGuard}
       ${sleepingContainerRetentionGuardSql('nodes')}
       ${boundedWarmPlacementClaimGuardSql('nodes.id')}
       ${workspaceIdleGuard}`
  )
    .bind(
      nowIso,
      node.id,
      node.user_id,
      node.status,
      nowIso,
      ...(options.expectedLastHeartbeatAt === undefined ? [] : [options.expectedLastHeartbeatAt]),
      ...(options.boundedStrandedRetirement
        ? [
            options.boundedStrandedRetirement.providerInstanceId,
            options.boundedStrandedRetirement.runtimeIncarnationId,
          ]
        : options.preservedVm
          ? [options.preservedVm.sourcesJson, options.preservedVm.sourcesJson]
          : []),
      workspaceIdleThresholdIso,
      ...(options.requireWorkspaceIdle === false ? [] : [workspaceIdleThresholdIso])
    )
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function releaseNodeCleanupClaim(
  env: Env,
  node: CleanupNode,
  nowIso: string,
  backoffUntil: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE nodes
     SET status = ?, cleanup_blocked_since = NULL, cleanup_blocked_reason = NULL, cleanup_backoff_until = ?, updated_at = ?
     WHERE id = ?
       AND user_id = ?
       AND status = 'destroying'`
  )
    .bind(node.status, backoffUntil, nowIso, node.id, node.user_id)
    .run();
}
