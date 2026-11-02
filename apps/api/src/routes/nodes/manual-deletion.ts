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
import { completeOwnerNodeRemoval } from './delete';

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

  const strandedTasks = await listStrandedNodeTasks(c.env, nodeId);
  const { node, runtimeTerminationConfirmedAt } = await recordManualNodeDeletion(
    db,
    c.env,
    nodeId,
    userId
  );

  let backendDnsDeleted = !node.backendDnsRecordId;
  if (node.backendDnsRecordId) {
    try {
      await deleteDNSRecord(node.backendDnsRecordId, c.env);
      backendDnsDeleted = true;
    } catch (error) {
      log.warn('node_manual_deletion.dns_cleanup_failed', {
        nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await completeOwnerNodeRemoval({
    env: c.env,
    db,
    node,
    userId,
    cleanup: {
      nodeFound: true,
      runtimeTerminationConfirmed: true,
      providerVmDeleted: false,
      providerVmDeleteSkippedReason: 'owner_attested_manual_deletion',
      backendDnsDeleted,
      runtimeTerminationConfirmedAt,
      runtimeIncarnationId: node.runtimeIncarnationId,
      errors: [],
    },
    strandedTasks,
    reason: 'owner_attested_manual_deletion',
  });
  return c.json({ success: true });
}
