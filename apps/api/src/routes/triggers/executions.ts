/**
 * Trigger Execution History Routes
 *
 * GET /:triggerId/executions               — List executions (paginated)
 * GET /:triggerId/executions/:executionId   — Get single execution detail
 */
import type { ListTriggerExecutionsResponse, TriggerExecutionResponse, TriggerExecutionStatus } from '@simple-agent-manager/shared';
import { TRIGGER_EXECUTION_STATUSES } from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';

const executionRoutes = new Hono<{ Bindings: Env }>();

/** Default and max page sizes for execution list. */
const DEFAULT_EXECUTION_LIMIT = 20;
const MAX_EXECUTION_LIMIT = 100;

function toExecutionResponse(row: schema.TriggerExecutionRow): TriggerExecutionResponse {
  return {
    id: row.id,
    triggerId: row.triggerId,
    projectId: row.projectId,
    status: row.status as TriggerExecutionStatus,
    skipReason: row.skipReason as TriggerExecutionResponse['skipReason'],
    taskId: row.taskId,
    eventType: row.eventType ?? 'cron',
    renderedPrompt: row.renderedPrompt,
    errorMessage: row.errorMessage,
    scheduledAt: row.scheduledAt ?? row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    sequenceNumber: row.sequenceNumber ?? 0,
    createdAt: row.createdAt,
  };
}

// =============================================================================
// GET /:triggerId/executions — List executions (paginated)
// =============================================================================
executionRoutes.get('/:triggerId/executions', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  await requireOwnedProject(db, projectId, userId);

  // Verify trigger exists and belongs to project
  const [trigger] = await db
    .select({ id: schema.triggers.id })
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.id, triggerId),
        eq(schema.triggers.projectId, projectId)
      )
    )
    .limit(1);

  if (!trigger) {
    throw errors.notFound('Trigger');
  }

  // Parse pagination
  const limit = Math.min(
    parsePositiveInt(c.req.query('limit'), DEFAULT_EXECUTION_LIMIT),
    MAX_EXECUTION_LIMIT
  );
  const offset = parsePositiveInt(c.req.query('offset'), 0) || 0;

  // Optional status filter
  const statusFilter = c.req.query('status') as TriggerExecutionStatus | undefined;
  if (statusFilter && !(TRIGGER_EXECUTION_STATUSES as readonly string[]).includes(statusFilter)) {
    throw errors.badRequest(`Invalid status filter. Must be one of: ${TRIGGER_EXECUTION_STATUSES.join(', ')}`);
  }

  const conditions = [eq(schema.triggerExecutions.triggerId, triggerId)];
  if (statusFilter) {
    conditions.push(eq(schema.triggerExecutions.status, statusFilter));
  }

  const rows = await db
    .select()
    .from(schema.triggerExecutions)
    .where(and(...conditions))
    .orderBy(desc(schema.triggerExecutions.createdAt))
    .limit(limit + 1) // +1 to detect next page
    .offset(offset);

  const hasMore = rows.length > limit;
  const executions = rows.slice(0, limit).map(toExecutionResponse);

  const response: ListTriggerExecutionsResponse = {
    executions,
    nextCursor: hasMore ? String(offset + limit) : null,
  };

  return c.json(response);
});

// =============================================================================
// GET /:triggerId/executions/:executionId — Single execution detail
// =============================================================================
executionRoutes.get('/:triggerId/executions/:executionId', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const executionId = c.req.param('executionId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId || !executionId) {
    throw errors.badRequest('projectId, triggerId, and executionId are required');
  }

  await requireOwnedProject(db, projectId, userId);

  const [execution] = await db
    .select()
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.id, executionId),
        eq(schema.triggerExecutions.triggerId, triggerId)
      )
    )
    .limit(1);

  if (!execution) {
    throw errors.notFound('Trigger execution');
  }

  return c.json(toExecutionResponse(execution));
});

export { executionRoutes };
