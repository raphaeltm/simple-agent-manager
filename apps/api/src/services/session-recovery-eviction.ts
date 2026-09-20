import type * as schema from '../db/schema';
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';

export interface SessionRecoveryOptions {
  excludedNodeId?: string | null;
  evictionFence?: {
    workspaceId: string;
    nodeId: string;
    generation: string | null;
  };
}

export function sourceTaskExplicitLocationRequirement(task: schema.Task | null): boolean | null {
  if (!task?.placementExplanationJson) return null;
  try {
    const explicitVmLocation = expectJsonRecord(
      JSON.parse(task.placementExplanationJson),
      'session_recovery.placement_explanation'
    ).explicitVmLocation;
    return typeof explicitVmLocation === 'boolean' ? explicitVmLocation : null;
  } catch {
    return null;
  }
}

export async function evictionRecoveryFenceMatches(
  env: Env,
  fence: NonNullable<SessionRecoveryOptions['evictionFence']>
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS valid
       FROM workspaces
      WHERE id = ? AND node_id = ? AND eviction_generation IS ? AND status = 'evicted'`
  )
    .bind(fence.workspaceId, fence.nodeId, fence.generation)
    .first<{ valid: number }>();
  return row?.valid === 1;
}
