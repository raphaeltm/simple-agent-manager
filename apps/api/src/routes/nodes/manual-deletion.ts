import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireNodeOwnership } from '../../middleware/node-auth';
import { deleteDNSRecord } from '../../services/dns';
import { recordManualNodeDeletion } from '../../services/node-manual-deletion';
import { recordOperatorRetirementAudit } from '../../services/node-operator-retirement';
import { listStrandedNodeTasks } from '../../services/node-stranded-tasks';
import { completeOwnerNodeRemoval, OWNER_ATTESTED_REMOVAL_REASON } from './delete';

/**
 * POST /api/nodes/:id/manual-deletion — the owner confirms they deleted the
 * node's server at their provider, so SAM removes the node it could not tear
 * down itself. The body must be `{ "confirmed": true }`.
 *
 * On SAM-managed capacity only a superadmin may do this, as the operator, and only on proof
 * the server is gone (`services/node-operator-retirement.ts`). `confirmNodeName` carries the
 * node name the operator typed when the provider cannot be asked.
 */
export async function confirmManualNodeDeletionRoute(c: Context<{ Bindings: Env }>) {
  const nodeId = c.req.param('id');
  if (!nodeId) throw errors.badRequest('Node id is required');
  const auth = getAuth(c);
  const userId = auth.user.id;
  // Validated by ConfirmManualNodeDeletionSchema where the route is registered (routes/nodes.ts).
  const body = c.req.valid('json' as never) as unknown as { confirmNodeName?: string };
  const db = drizzle(c.env.DATABASE, { schema });
  const owned = await requireNodeOwnership(c, nodeId);
  if (!owned) throw errors.notFound('Node');

  const strandedTasks = await listStrandedNodeTasks(c.env, nodeId);
  const { node, runtimeTerminationConfirmedAt, operatorProof } = await recordManualNodeDeletion(
    db,
    c.env,
    nodeId,
    userId,
    { actorIsSuperadmin: auth.user.role === 'superadmin', confirmNodeName: body.confirmNodeName }
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
    reason: OWNER_ATTESTED_REMOVAL_REASON,
  });
  if (operatorProof) await recordOperatorRetirementAudit(c.env, userId, node, operatorProof);
  return c.json({ success: true });
}
