import type { ProjectOwnershipTransferResponse } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { jsonValidator, TransferProjectOwnershipSchema } from '../../schemas';

export const projectOwnershipTransferRoutes = new Hono<{ Bindings: Env }>();

projectOwnershipTransferRoutes.post(
  '/:id/ownership-transfer',
  jsonValidator(TransferProjectOwnershipSchema),
  async (c) => {
    const actorUserId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, actorUserId, 'project:transfer_ownership');

    const body = c.req.valid('json');
    const toUserId = body.toUserId.trim();
    const oldOwnerRole = body.oldOwnerRole ?? 'admin';
    if (!toUserId) {
      throw errors.badRequest('toUserId is required');
    }
    if (toUserId === actorUserId) {
      throw errors.badRequest('Ownership target must be another project member');
    }

    const targetRows = await db
      .select()
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.userId, toUserId)
        )
      )
      .limit(1);
    const targetMember = targetRows[0];
    if (!targetMember || targetMember.status !== 'active') {
      throw errors.notFound('Active project member');
    }
    if (targetMember.role !== 'admin') {
      throw errors.badRequest('Ownership can only be transferred to an active admin member');
    }

    const completedAt = new Date().toISOString();
    const transferId = ulid();

    const results = await c.env.DATABASE.batch([
      c.env.DATABASE.prepare(
        `UPDATE project_members
         SET role = ?, updated_at = ?
         WHERE project_id = ? AND user_id = ? AND status = 'active' AND role = 'admin'`
      ).bind('owner', completedAt, projectId, toUserId),
      c.env.DATABASE.prepare(
        `UPDATE project_members
         SET role = ?, updated_at = ?
         WHERE project_id = ? AND user_id = ? AND status = 'active' AND role = 'owner'`
      ).bind(oldOwnerRole, completedAt, projectId, actorUserId),
      c.env.DATABASE.prepare(
        `UPDATE projects
         SET user_id = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      ).bind(toUserId, completedAt, projectId, actorUserId),
      c.env.DATABASE.prepare(
        `INSERT INTO project_ownership_transfers
         (id, project_id, from_user_id, to_user_id, initiated_by, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(transferId, projectId, actorUserId, toUserId, actorUserId, completedAt, completedAt),
    ]);

    if (results.slice(0, 3).some((result) => result.meta.changes !== 1)) {
      throw errors.conflict('Ownership transfer state changed; retry ownership transfer');
    }

    const response: ProjectOwnershipTransferResponse = {
      projectId,
      fromUserId: actorUserId,
      toUserId,
      fromRole: oldOwnerRole,
      toRole: 'owner',
      completedAt,
    };
    return c.json(response);
  }
);
