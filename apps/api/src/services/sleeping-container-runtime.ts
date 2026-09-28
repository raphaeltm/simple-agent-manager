/**
 * Whether an Instant (cf-container) runtime is asleep, for callers that must not wake it.
 *
 * A slept container runs no agent, and any request proxied to it first restores it from its
 * snapshot (`VmAgentContainer.prepareForRequest` → `ensureAwake`). A prompt wants that wake.
 * A caller that only signals a live agent (cancel, stop, suspend) or asks whether a turn is
 * in flight must skip a sleeping runtime instead of booting it to ask.
 *
 * Reads the node mirror that every sleep writer sets (`persistRuntimeSleeping`,
 * `persistRuntimeSleepingAfterRevokedWake`, `completeSleepTeardown`) and the wake clears
 * first (`persistRuntimeRecovering`).
 */
import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export function isSleepingContainerRuntime(node: {
  nodeRuntime: string | null;
  nodeStatus: string | null;
}): boolean {
  return node.nodeRuntime === 'cf-container' && node.nodeStatus === 'sleeping';
}

/** `isSleepingContainerRuntime` for a node read by ID; a missing node is not asleep. */
export async function isSleepingContainerNode(db: Db, nodeId: string): Promise<boolean> {
  const [node] = await db
    .select({ runtime: schema.nodes.runtime, status: schema.nodes.status })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  return isSleepingContainerRuntime({
    nodeRuntime: node?.runtime ?? null,
    nodeStatus: node?.status ?? null,
  });
}
