/**
 * cc_attachments routes, registered on the `/api/cc` router (which applies auth).
 *
 * A project-scoped attachment pins one of the caller's accounts to a project. The
 * resolver (`resolveEnvironment`) takes the first project attachment it finds for a
 * consumer, so a project keeps exactly one: attaching replaces the previous pin. The
 * same configuration may be attached to any number of projects.
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { reconcileCapacityPoolsForCredentialMutation } from '../services/capacity-pool-credential-lifecycle';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export function uniqueProjectIds(projectIds: Array<string | null>): string[] {
  return [...new Set(projectIds.filter((projectId): projectId is string => !!projectId))];
}

/**
 * A paused account pinned to a project halts that project's resolution (no
 * fallback), so only an active configuration and credential can be pinned.
 */
async function requireActiveAccount(
  db: Db,
  userId: string,
  cfg: { isActive: boolean; credentialId: string | null }
): Promise<void> {
  if (!cfg.isActive) throw errors.badRequest('This account is paused');
  if (!cfg.credentialId) return;
  const [credential] = await db
    .select({ isActive: schema.ccCredentials.isActive })
    .from(schema.ccCredentials)
    .where(
      and(eq(schema.ccCredentials.id, cfg.credentialId), eq(schema.ccCredentials.ownerId, userId))
    )
    .limit(1);
  if (!credential) throw errors.badRequest('Credential not found or not owned by user');
  if (!credential.isActive) throw errors.badRequest('This account is paused');
}

export function registerCCAttachmentRoutes(ccRoutes: Hono<{ Bindings: Env }>): void {
  /** GET /api/cc/attachments — list user's attachments */
  ccRoutes.get('/attachments', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);

    const rows = await db
      .select()
      .from(schema.ccAttachments)
      .where(eq(schema.ccAttachments.userId, userId));

    const attachments = rows.map((row) => ({
      id: row.id,
      configurationId: row.configurationId,
      consumerKind: row.consumerKind,
      consumerTarget: row.consumerTarget,
      projectId: row.projectId,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return c.json({ attachments });
  });

  /** POST /api/cc/attachments — create an attachment */
  ccRoutes.post('/attachments', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const body = await c.req.json();

    const { configurationId, projectId } = body;
    if (!configurationId) {
      throw errors.badRequest('configurationId is required');
    }

    // Verify configuration belongs to user
    const [cfg] = await db
      .select()
      .from(schema.ccConfigurations)
      .where(
        and(
          eq(schema.ccConfigurations.id, configurationId),
          eq(schema.ccConfigurations.ownerId, userId)
        )
      )
      .limit(1);
    if (!cfg) throw errors.badRequest('Configuration not found or not owned by user');

    const id = `cc-att-${ulid()}`;
    const insert = db.insert(schema.ccAttachments).values({
      id,
      configurationId,
      consumerKind: cfg.consumerKind,
      consumerTarget: cfg.consumerTarget,
      userId,
      projectId: projectId ?? null,
      isActive: true,
    });

    if (projectId) {
      // Same capability the project pin route (PUT /api/projects/:id/credentials) requires.
      await requireProjectCapability(db, projectId, userId, 'secret:write');
      await requireActiveAccount(db, userId, cfg);
      // The resolver takes the first project attachment it finds for a consumer, so a
      // project keeps exactly one: pinning an account replaces the previous pin.
      await db.batch([
        db
          .delete(schema.ccAttachments)
          .where(
            and(
              eq(schema.ccAttachments.userId, userId),
              eq(schema.ccAttachments.projectId, projectId),
              eq(schema.ccAttachments.consumerKind, cfg.consumerKind),
              eq(schema.ccAttachments.consumerTarget, cfg.consumerTarget)
            )
          ),
        insert,
      ]);
    } else {
      await insert;
    }
    await reconcileCapacityPoolsForCredentialMutation(
      c.env,
      projectId ? { scope: 'project', userId, projectId } : { scope: 'user', userId }
    );

    return c.json({ id, configurationId, projectId: projectId ?? null }, 201);
  });

  /** PATCH /api/cc/attachments/:id — update an attachment (isActive) */
  ccRoutes.patch('/attachments/:id', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const { id } = c.req.param();
    const body = await c.req.json();

    const updates: Record<string, unknown> = {};
    if (typeof body.isActive === 'boolean') updates.isActive = body.isActive;

    if (Object.keys(updates).length === 0) {
      throw errors.badRequest('No valid fields to update');
    }
    updates.updatedAt = sql`(datetime('now'))`;

    const result = await db
      .update(schema.ccAttachments)
      .set(updates)
      .where(and(eq(schema.ccAttachments.id, id), eq(schema.ccAttachments.userId, userId)))
      .returning({ id: schema.ccAttachments.id, projectId: schema.ccAttachments.projectId });

    if (result.length === 0) throw errors.notFound('Attachment');
    await reconcileCapacityPoolsForCredentialMutation(c.env, {
      scope: 'user',
      userId,
      projectIds: uniqueProjectIds(result.map((row) => row.projectId)),
    });
    return c.json({ success: true });
  });

  /** DELETE /api/cc/attachments/:id */
  ccRoutes.delete('/attachments/:id', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const userId = getUserId(c);
    const { id } = c.req.param();

    const result = await db
      .delete(schema.ccAttachments)
      .where(and(eq(schema.ccAttachments.id, id), eq(schema.ccAttachments.userId, userId)))
      .returning({ id: schema.ccAttachments.id, projectId: schema.ccAttachments.projectId });

    if (result.length === 0) throw errors.notFound('Attachment');
    await reconcileCapacityPoolsForCredentialMutation(c.env, {
      scope: 'user',
      userId,
      projectIds: uniqueProjectIds(result.map((row) => row.projectId)),
    });
    return c.json({ success: true });
  });
}
