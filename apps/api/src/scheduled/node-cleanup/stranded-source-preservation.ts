import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { verifyVmFallbackRetirement } from '../../services/preserved-vm-fallback';
import { automaticDeletionPreservationExpiresAt } from '../../services/workspace-deletion-preservation';

export const RetirementSourceSchema = v.object({
  workspaceId: v.nullable(v.string()),
  snapshotId: v.nullable(v.string()),
  snapshotGeneration: v.nullable(v.string()),
  workspaceGeneration: v.nullable(v.string()),
  projectId: v.nullable(v.string()),
  chatSessionId: v.nullable(v.string()),
  runtimeIncarnationId: v.nullable(v.string()),
  providerInstanceId: v.nullable(v.string()),
  preservationPending: v.optional(v.boolean()),
});
export type RetirementSource = v.InferOutput<typeof RetirementSourceSchema>;

export async function verifyRetirementSource(
  env: Env,
  node: { id: string; user_id: string },
  source: RetirementSource
): Promise<boolean> {
  if (!source.workspaceId) return false;
  const identity = {
    workspaceId: source.workspaceId,
    workspaceGeneration: source.workspaceGeneration,
    nodeId: node.id,
    nodeUserId: node.user_id,
    nodeRuntime: 'vm',
    nodeProviderInstanceId: source.providerInstanceId,
    nodeRuntimeIncarnationId: source.runtimeIncarnationId,
    userId: node.user_id,
    projectId: source.projectId,
    chatSessionId: source.chatSessionId,
  };
  if (await automaticDeletionPreservationExpiresAt(env, identity, 'vm_retirement')) return true;
  if (!source.snapshotId) return false;
  const snapshot = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.id, source.snapshotId))
    .get();
  return (
    !!snapshot &&
    snapshot.snapshotGeneration === source.snapshotGeneration &&
    (await verifyVmFallbackRetirement(env, identity, snapshot))
  );
}
