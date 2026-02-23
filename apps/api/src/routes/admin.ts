import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { requireAuth, requireApproved, requireSuperadmin, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import type { UserRole, UserStatus } from '@simple-agent-manager/shared';

const adminRoutes = new Hono<{ Bindings: Env }>();

// All admin routes require auth + approval + superadmin
adminRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * GET /api/admin/users - List all users
 * Optional query param: ?status=pending|active|suspended
 */
adminRoutes.get('/users', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const statusFilter = c.req.query('status') as UserStatus | undefined;

  let query = db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      role: schema.users.role,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users);

  if (statusFilter && ['active', 'pending', 'suspended'].includes(statusFilter)) {
    query = query.where(eq(schema.users.status, statusFilter)) as typeof query;
  }

  const users = await query.all();

  return c.json({
    users: users.map((u) => ({
      ...u,
      createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
    })),
  });
});

/**
 * PATCH /api/admin/users/:userId - Approve or suspend a user
 * Body: { action: 'approve' | 'suspend' }
 */
adminRoutes.patch('/users/:userId', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const body = await c.req.json<{ action: string }>();

  if (!body.action || !['approve', 'suspend'].includes(body.action)) {
    throw errors.badRequest('action must be "approve" or "suspend"');
  }

  const target = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!target) {
    throw errors.notFound('User');
  }

  // Cannot modify other superadmins
  if (target.role === 'superadmin') {
    throw errors.forbidden('Cannot modify a superadmin account');
  }

  const newStatus: UserStatus = body.action === 'approve' ? 'active' : 'suspended';

  await db
    .update(schema.users)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));

  return c.json({ id: userId, status: newStatus });
});

/**
 * PATCH /api/admin/users/:userId/role - Change a user's role
 * Body: { role: 'admin' | 'user' }
 */
adminRoutes.patch('/users/:userId/role', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const currentUserId = getUserId(c);
  const body = await c.req.json<{ role: string }>();

  if (!body.role || !['admin', 'user'].includes(body.role)) {
    throw errors.badRequest('role must be "admin" or "user"');
  }

  if (userId === currentUserId) {
    throw errors.badRequest('Cannot change your own role');
  }

  const target = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!target) {
    throw errors.notFound('User');
  }

  if (target.role === 'superadmin') {
    throw errors.forbidden('Cannot change a superadmin role');
  }

  const newRole = body.role as UserRole;

  await db
    .update(schema.users)
    .set({
      role: newRole,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));

  return c.json({ id: userId, role: newRole });
});

export { adminRoutes };
