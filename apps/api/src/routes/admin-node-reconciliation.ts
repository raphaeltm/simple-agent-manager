import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas';
import {
  ProviderAbsenceReconciliationError,
  reconcileNodeProviderAbsence,
} from '../services/provider-absence-reconciliation';

const adminNodeReconciliationRoutes = new Hono<{ Bindings: Env }>();

const ReconcileProviderAbsenceSchema = v.object({
  confirmAbsence: v.optional(v.boolean(), false),
  expectedRuntimeIncarnationId: v.optional(v.string()),
});

/**
 * POST /api/admin/node-reconciliation/:nodeId/provider-absence
 *
 * Superadmin-only operator reconciliation for managed VM placeholders whose
 * provider create response was lost before `provider_instance_id` persisted. The
 * route resolves the exact placement credential inside the Worker, performs a
 * provider inventory query using the exact SAM labels and incarnation, and writes
 * runtime termination proof only when the current provider inventory has zero
 * exact matches. It never returns provider credential material.
 */
adminNodeReconciliationRoutes.post(
  '/:nodeId/provider-absence',
  jsonValidator(ReconcileProviderAbsenceSchema),
  async (c) => {
    const { nodeId } = c.req.param();
    const body = c.req.valid('json');
    try {
      const result = await reconcileNodeProviderAbsence(c.env, {
        nodeId,
        confirmAbsence: body.confirmAbsence ?? false,
        expectedRuntimeIncarnationId: body.expectedRuntimeIncarnationId,
      });
      return c.json({ reconciliation: result });
    } catch (error) {
      if (error instanceof ProviderAbsenceReconciliationError) {
        if (error.code === 'not_found') throw errors.notFound('Node');
        if (error.code === 'cas_failed') throw errors.conflict(error.message);
        if (error.code === 'credential_unavailable') throw errors.conflict(error.message);
        throw errors.unprocessable(error.message);
      }
      throw error;
    }
  }
);

export { adminNodeReconciliationRoutes };
