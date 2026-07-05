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

    await db.transaction(async (tx) => {
      const promotedRows = await tx
        .update(schema.projectMembers)
        .set({ role: 'owner', updatedAt: completedAt })
        .where(
          and(
            eq(schema.projectMembers.projectId, projectId),
            eq(schema.projectMembers.userId, toUserId),
            eq(schema.projectMembers.status, 'active'),
            eq(schema.projectMembers.role, 'admin')
          )
        )
        .returning({ userId: schema.projectMembers.userId });
      if (promotedRows.length !== 1) {
        throw errors.conflict('Ownership transfer state changed; retry ownership transfer');
      }

      const demotedRows = await tx
        .update(schema.projectMembers)
        .set({ role: oldOwnerRole, updatedAt: completedAt })
        .where(
          and(
            eq(schema.projectMembers.projectId, projectId),
            eq(schema.projectMembers.userId, actorUserId),
            eq(schema.projectMembers.status, 'active'),
            eq(schema.projectMembers.role, 'owner')
          )
        )
        .returning({ userId: schema.projectMembers.userId });
      if (demotedRows.length !== 1) {
        throw errors.conflict('Ownership transfer state changed; retry ownership transfer');
      }

      const projectRows = await tx
        .update(schema.projects)
        .set({ userId: toUserId, updatedAt: completedAt })
        .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, actorUserId)))
        .returning({ id: schema.projects.id });
      if (projectRows.length !== 1) {
        throw errors.conflict('Ownership transfer state changed; retry ownership transfer');
      }

      await tx.insert(schema.projectOwnershipTransfers).values({
        id: transferId,
        projectId,
        fromUserId: actorUserId,
        toUserId,
        initiatedBy: actorUserId,
        completedAt,
        createdAt: completedAt,
      });
    });

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
