/**
 * Mailbox REST API routes — message inspection and management.
 *
 * Mounted at /api/projects/:projectId/mailbox
 * Provides list, get, and cancel for durable messages (admin/UI use).
 */
import type { DeliveryState, MessageClass } from '@simple-agent-manager/shared';
import { DELIVERY_STATES, MESSAGE_CLASSES } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

const mailboxRoutes = new Hono<{ Bindings: Env }>();

mailboxRoutes.use('/*', requireAuth(), requireApproved());

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw errors.badRequest(`Missing required parameter: ${name}`);
  return value;
}

// ─── GET / — list messages ───────────���─────────────────────────────────────

mailboxRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const deliveryState = c.req.query('deliveryState') as DeliveryState | undefined;
  if (deliveryState && !(DELIVERY_STATES as readonly string[]).includes(deliveryState)) {
    throw errors.badRequest(`Invalid deliveryState. Must be one of: ${DELIVERY_STATES.join(', ')}`);
  }

  const messageClass = c.req.query('messageClass') as MessageClass | undefined;
  if (messageClass && !(MESSAGE_CLASSES as readonly string[]).includes(messageClass)) {
    throw errors.badRequest(`Invalid messageClass. Must be one of: ${MESSAGE_CLASSES.join(', ')}`);
  }

  const targetSessionId = c.req.query('targetSessionId') || undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  const result = await projectDataService.listMailboxMessages(c.env, projectId, {
    deliveryState,
    messageClass,
    targetSessionId,
    limit,
    offset,
  });

  return c.json(result);
});

// ─── GET /stats — mailbox stats ─────────────────────────────────────────────

mailboxRoutes.get('/stats', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const stats = await projectDataService.getMailboxStats(c.env, projectId);
  return c.json(stats);
});

// ─── GET /:messageId — get single message ────────���─────────────────────────

mailboxRoutes.get('/:messageId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const messageId = requireParam(c.req.param('messageId'), 'messageId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const message = await projectDataService.getMailboxMessage(c.env, projectId, messageId);
  if (!message) {
    throw errors.notFound('Message not found');
  }

  return c.json(message);
});

// ─���─ DELETE /:messageId — cancel a queued message ──────────────────────────

mailboxRoutes.delete('/:messageId', async (c) => {
  const auth = getAuth(c);
  const projectId = requireParam(c.req.param('projectId'), 'projectId');
  const messageId = requireParam(c.req.param('messageId'), 'messageId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, auth.user.id);

  const cancelled = await projectDataService.cancelMailboxMessage(c.env, projectId, messageId);
  if (!cancelled) {
    throw errors.badRequest('Message cannot be cancelled (already delivered, acked, or expired)');
  }

  return c.json({ cancelled: true, messageId });
});

export { mailboxRoutes };
