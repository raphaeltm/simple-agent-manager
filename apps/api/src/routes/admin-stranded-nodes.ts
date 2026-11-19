/**
 * Superadmin view and escape path for SAM-capacity nodes stuck in teardown (Admin →
 * Infrastructure, "Stuck nodes"). The owner's own path (`POST /api/nodes/:id/manual-deletion`)
 * refuses SAM capacity, because only an operator can look inside SAM's cloud account.
 *
 *   GET  /api/admin/nodes/stranded                 SAM-capacity VM nodes in `destroying`
 *   POST /api/admin/nodes/:id/operator-deletion    { confirmation: <node ID>, note }
 */
import { assertNoReservedCloudflareBuilds } from '@simple-agent-manager/app-deployment';
import {
  DEFAULT_ADMIN_STRANDED_NODES_LIMIT,
  type ListAdminStrandedNodesResponse,
  MAX_ADMIN_STRANDED_NODES_LIMIT,
  OPERATOR_NODE_DELETION_NOTE_MAX_CHARS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator } from '../schemas';
import {
  listStrandedPlatformNodes,
  OPERATOR_ATTESTED_REMOVAL_REASON,
  recordOperatorNodeDeletion,
} from '../services/node-operator-deletion';
import { listStrandedNodeTasks } from '../services/node-stranded-tasks';
import { completeAttestedNodeRemoval } from './nodes/manual-deletion';

const OperatorNodeDeletionSchema = v.object({
  confirmation: v.pipe(v.string(), v.maxLength(200)),
  note: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(OPERATOR_NODE_DELETION_NOTE_MAX_CHARS)
  ),
});

const adminStrandedNodeRoutes = new Hono<{ Bindings: Env }>();

adminStrandedNodeRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);

function limitParam(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_ADMIN_STRANDED_NODES_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw errors.badRequest('limit must be a positive integer');
  }
  return Math.min(parsed, MAX_ADMIN_STRANDED_NODES_LIMIT);
}

adminStrandedNodeRoutes.get('/stranded', async (c) => {
  const page = await listStrandedPlatformNodes(c.env, limitParam(c.req.query('limit')));
  return c.json<ListAdminStrandedNodesResponse>(page);
});

adminStrandedNodeRoutes.post(
  '/:id/operator-deletion',
  jsonValidator(OperatorNodeDeletionSchema),
  async (c) => {
    const nodeId = c.req.param('id');
    const body = c.req.valid('json');
    const operatorUserId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    await assertNoReservedCloudflareBuilds(db, { nodeId });
    // Listed before the proof is written, exactly as the owner's Delete and manual removal do.
    const strandedTasks = await listStrandedNodeTasks(c.env, nodeId);
    const { node, runtimeTerminationConfirmedAt } = await recordOperatorNodeDeletion(db, c.env, {
      nodeId,
      operatorUserId,
      confirmation: body.confirmation,
      note: body.note,
    });
    await completeAttestedNodeRemoval({
      env: c.env,
      db,
      node,
      runtimeTerminationConfirmedAt,
      strandedTasks,
      reason: OPERATOR_ATTESTED_REMOVAL_REASON,
    });
    return c.json({ success: true });
  }
);

export { adminStrandedNodeRoutes };
