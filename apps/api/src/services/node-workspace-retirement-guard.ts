import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { preservedVmSourceSql, type PreservedVmRetirement } from './preserved-vm-retirement';
import { boundedWarmPlacementClaimGuardSql } from './warm-placement-claims';

/** Authority from the SAME durable deletion operation, never a generic retirement waiver. */
export interface ContainerWorkspaceDeletionAuthority {
  workspaceId: string;
  workspaceGeneration: string;
  beforeDestroy: () => Promise<void>;
}

/** Logical deletion, eviction, or snapshot success never proves local bytes are gone. */
export function workspaceArtifactsRetirementGuardSql(
  nodeAlias: string,
  allowExactTarget = false,
  allowPreservedVm = false
): string {
  const targetGuard = (alias: string) =>
    allowPreservedVm
      ? `AND NOT (${preservedVmSourceSql(alias, nodeAlias)})`
      : allowExactTarget
        ? `AND NOT (${alias}.id IS ? AND ${alias}.eviction_generation IS ?
        AND ${alias}.status IS 'stopping' AND ${alias}.user_id IS ${nodeAlias}.user_id
        AND ${alias}.node_id IS ${nodeAlias}.id)`
        : '';
  return `AND NOT EXISTS (
    SELECT 1 FROM workspaces artifact_workspace
    WHERE artifact_workspace.node_id = ${nodeAlias}.id
      ${targetGuard('artifact_workspace')}
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
      ${
        allowPreservedVm
          ? `AND NOT (artifact_snapshot.user_id IS ${nodeAlias}.user_id
            AND artifact_snapshot.chat_session_id IS source_workspace.chat_session_id
            AND artifact_snapshot.project_id IS source_workspace.project_id
            AND ${preservedVmSourceSql('source_workspace', nodeAlias)})`
          : allowExactTarget
            ? `AND NOT (artifact_snapshot.user_id IS ${nodeAlias}.user_id
        AND source_workspace.id IS ? AND source_workspace.eviction_generation IS ?
        AND source_workspace.status IS 'stopping' AND source_workspace.user_id IS ${nodeAlias}.user_id
        AND source_workspace.node_id IS ${nodeAlias}.id)`
            : ''
      }
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
  },
  workspaceDeletion?: ContainerWorkspaceDeletionAuthority,
  preservedVm?: PreservedVmRetirement
): Promise<void> {
  if (workspaceDeletion) {
    if (
      expectedRuntime?.runtime !== 'cf-container' ||
      !expectedRuntime.runtimeIncarnationId ||
      !workspaceDeletion.workspaceId ||
      !workspaceDeletion.workspaceGeneration
    ) {
      throw new Error('Exact container deletion authority is incomplete');
    }
    await workspaceDeletion.beforeDestroy();
  }
  if (preservedVm) {
    if (
      workspaceDeletion ||
      expectedRuntime?.runtime !== 'vm' ||
      expectedRuntime.runtimeIncarnationId !== preservedVm.runtimeIncarnationId ||
      expectedRuntime.providerInstanceId !== preservedVm.providerInstanceId
    )
      throw new Error('Preserved VM retirement authority does not match runtime');
    await preservedVm.beforeDestroy();
  }
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
      ${workspaceArtifactsRetirementGuardSql('nodes', !!workspaceDeletion, !!preservedVm)}
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
      ...(workspaceDeletion
        ? [
            workspaceDeletion.workspaceId,
            workspaceDeletion.workspaceGeneration,
            workspaceDeletion.workspaceId,
            workspaceDeletion.workspaceGeneration,
          ]
        : []),
      ...(preservedVm ? [preservedVm.sourcesJson, preservedVm.sourcesJson] : []),
      threshold
    )
    .first<{ id: string }>();
  if (!safe) {
    throw new Error(
      'Node retirement blocked by unconfirmed workspace artifacts or placement claim'
    );
  }
}
