import { assertNoReservedCloudflareBuilds } from '@simple-agent-manager/app-deployment';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireNodeOwnership } from '../../middleware/node-auth';
import { deleteDNSRecord } from '../../services/dns';
import { recordManualNodeDeletion } from '../../services/node-manual-deletion';
import { listStrandedNodeTasks } from '../../services/node-stranded-tasks';
import { completeOwnerNodeRemoval, OWNER_ATTESTED_REMOVAL_REASON } from './delete';

type NodesDb = ReturnType<typeof drizzle<typeof schema>>;
type NodeRow = typeof schema.nodes.$inferSelect;

/**
 * Everything after a person attested that a node's server is gone: best-effort backend DNS
 * cleanup, then the owner's removal tail run as the node's owner. Shared by the owner route below
 * and the superadmin route (`routes/admin-stranded-nodes.ts`), so there is one removal path.
 * `strandedTasks` must be listed before the proof is written, as the owner Delete does.
 */
export async function completeAttestedNodeRemoval(input: {
  env: Env;
  db: NodesDb;
  node: NodeRow;
  runtimeTerminationConfirmedAt: string;
  strandedTasks: Awaited<ReturnType<typeof listStrandedNodeTasks>>;
  reason: string;
}): Promise<void> {
  const { env, db, node } = input;
  let backendDnsDeleted = !node.backendDnsRecordId;
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, env);
      backendDnsDeleted = true;
    } catch (error) {
      log.warn('node_manual_deletion.dns_cleanup_failed', {
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await completeOwnerNodeRemoval({
    env,
    db,
    node,
    userId: node.userId,
    cleanup: {
      nodeFound: true,
      runtimeTerminationConfirmed: true,
      providerVmDeleted: false,
      providerVmDeleteSkippedReason: input.reason,
      backendDnsDeleted,
      runtimeTerminationConfirmedAt: input.runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      errors: [],
    },
    strandedTasks: input.strandedTasks,
    reason: input.reason,
  });
}

/**
 * POST /api/nodes/:id/manual-deletion — the owner confirms they deleted the
 * node's server at their provider, so SAM removes the node it could not tear
 * down itself. The body must be `{ "confirmed": true }`.
 */
export async function confirmManualNodeDeletionRoute(c: Context<{ Bindings: Env }>) {
  const nodeId = c.req.param('id');
  if (!nodeId) throw errors.badRequest('Node id is required');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const owned = await requireNodeOwnership(c, nodeId);
  if (!owned) throw errors.notFound('Node');

  await assertNoReservedCloudflareBuilds(db, { nodeId });
  const strandedTasks = await listStrandedNodeTasks(c.env, nodeId);
  const { node, runtimeTerminationConfirmedAt } = await recordManualNodeDeletion(
    db,
    c.env,
    nodeId,
    userId
  );
  await completeAttestedNodeRemoval({
    env: c.env,
    db,
    node,
    runtimeTerminationConfirmedAt,
    strandedTasks,
    reason: OWNER_ATTESTED_REMOVAL_REASON,
  });
  return c.json({ success: true });
}
