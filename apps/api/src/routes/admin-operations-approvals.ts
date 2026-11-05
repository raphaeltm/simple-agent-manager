/**
 * Superadmin approve/deny for Operations actions (Admin -> Approvals). The decision is the
 * server-side record `ops_execute_action` checks; it is never inferred from chat text.
 *
 *   GET  /api/admin/operations/approvals              list (pending first)
 *   GET  /api/admin/operations/approvals/:id          one approval
 *   POST /api/admin/operations/approvals/:id/decision { decision: 'approve' | 'deny', note? }
 */
import {
  OPERATIONS_APPROVAL_DECISIONS,
  OPERATIONS_APPROVAL_STATUSES,
  type OperationsApprovalStatus,
} from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator } from '../schemas';
import {
  getApproval,
  listApprovals,
  MAX_OPERATIONS_APPROVAL_LIST_LIMIT,
  OPERATIONS_APPROVAL_NOTE_MAX_CHARS,
  publicApproval,
} from '../services/operations-actions/approvals';
import { decideOperationsAction } from '../services/operations-actions/service';

const DecideApprovalSchema = v.object({
  decision: v.picklist(OPERATIONS_APPROVAL_DECISIONS),
  note: v.optional(v.pipe(v.string(), v.maxLength(OPERATIONS_APPROVAL_NOTE_MAX_CHARS))),
});

const adminOperationsApprovalRoutes = new Hono<{ Bindings: Env }>();

adminOperationsApprovalRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);

function statusParam(value: string | undefined): OperationsApprovalStatus | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(OPERATIONS_APPROVAL_STATUSES as readonly string[]).includes(value)) {
    throw errors.badRequest(`status must be one of: ${OPERATIONS_APPROVAL_STATUSES.join(', ')}`);
  }
  return value as OperationsApprovalStatus;
}

function limitParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw errors.badRequest('limit must be a positive integer');
  }
  return Math.min(parsed, MAX_OPERATIONS_APPROVAL_LIST_LIMIT);
}

adminOperationsApprovalRoutes.get('/', async (c) => {
  const approvals = await listApprovals(c.env.DATABASE, {
    status: statusParam(c.req.query('status')),
    limit: limitParam(c.req.query('limit')),
  });
  return c.json({ approvals: approvals.map(publicApproval) });
});

adminOperationsApprovalRoutes.get('/:id', async (c) => {
  const approval = await getApproval(c.env.DATABASE, c.req.param('id'));
  if (!approval) throw errors.notFound('Approval');
  return c.json({ approval: publicApproval(approval) });
});

adminOperationsApprovalRoutes.post(
  '/:id/decision',
  jsonValidator(DecideApprovalSchema),
  async (c) => {
    const body = c.req.valid('json');
    const outcome = await decideOperationsAction(c.env, {
      approvalId: c.req.param('id'),
      decision: body.decision,
      deciderUserId: getUserId(c),
      note: body.note?.trim() || null,
    });
    if (outcome.outcome === 'not_found') throw errors.notFound('Approval');
    if (outcome.outcome !== 'decided') {
      throw errors.conflict(
        outcome.outcome === 'expired'
          ? 'This request expired before it was decided'
          : `This request was already ${outcome.approval.status}`
      );
    }
    return c.json({ approval: publicApproval(outcome.approval), delivered: outcome.delivered });
  }
);

export { adminOperationsApprovalRoutes };
