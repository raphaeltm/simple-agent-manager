import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { boundedWarmPlacementClaimGuardSql } from './warm-placement-claims';

/** Logical deletion, eviction, or snapshot success never proves local bytes are gone. */
export function workspaceArtifactsRetirementGuardSql(nodeAlias: string): string {
  return `AND NOT EXISTS (
    SELECT 1 FROM workspaces artifact_workspace
    WHERE artifact_workspace.node_id = ${nodeAlias}.id
      AND (artifact_workspace.user_id IS NOT ${nodeAlias}.user_id
        OR artifact_workspace.runtime_deletion_confirmed_at IS NULL
        OR artifact_workspace.runtime_deletion_proof IS NULL
        OR artifact_workspace.runtime_deletion_proof NOT IN ('vm_agent_confirmed', 'workspace_never_started', 'node_runtime_terminated')
        OR artifact_workspace.status IN ('running', 'creating', 'recovery'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM session_snapshots artifact_snapshot
    LEFT JOIN workspaces source_workspace ON source_workspace.id = artifact_snapshot.workspace_id
    WHERE artifact_snapshot.node_id = ${nodeAlias}.id
      AND (artifact_snapshot.user_id IS NOT ${nodeAlias}.user_id
        OR source_workspace.id IS NULL
        OR source_workspace.node_id IS NOT ${nodeAlias}.id
        OR source_workspace.user_id IS NOT ${nodeAlias}.user_id
        OR source_workspace.runtime_deletion_confirmed_at IS NULL
        OR source_workspace.runtime_deletion_proof IS NULL
        OR source_workspace.runtime_deletion_proof NOT IN ('vm_agent_confirmed', 'workspace_never_started', 'node_runtime_terminated'))
  )`;
}

/** Rechecked after the node is fenced as destroying and immediately before destructive I/O. */
export async function requireNodeWorkspaceArtifactsDeleted(
  env: Env,
  nodeId: string,
  userId: string,
  expectedRuntime?: {
    runtime: string;
    providerInstanceId: string | null;
    runtimeIncarnationId: string | null;
  }
): Promise<void> {
  const configured = Number.parseInt(
    env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? env.NODE_ORPHAN_IDLE_TIMEOUT_MS ?? '',
    10
  );
  const threshold = new Date(
    Date.now() -
      (Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS)
  ).toISOString();
  const safe = await env.DATABASE.prepare(
    `
    SELECT id FROM nodes
    WHERE id = ? AND user_id = ?
      ${expectedRuntime ? 'AND runtime IS ? AND provider_instance_id IS ? AND runtime_incarnation_id IS ?' : ''}
      ${workspaceArtifactsRetirementGuardSql('nodes')}
      ${boundedWarmPlacementClaimGuardSql('nodes.id')}
  `
  )
    .bind(
      nodeId,
      userId,
      ...(expectedRuntime
        ? [
            expectedRuntime.runtime,
            expectedRuntime.providerInstanceId,
            expectedRuntime.runtimeIncarnationId,
          ]
        : []),
      threshold
    )
    .first<{ id: string }>();
  if (!safe) {
    throw new Error(
      'Node retirement blocked by unconfirmed workspace artifacts or placement claim'
    );
  }
}
