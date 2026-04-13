/**
 * Trigger CRUD Routes
 *
 * POST   /                   — Create a new trigger
 * GET    /                   — List triggers for a project
 * GET    /:triggerId         — Get trigger details + recent executions
 * PATCH  /:triggerId         — Update trigger
 * DELETE /:triggerId         — Delete trigger (cascade executions)
 * POST   /:triggerId/test    — Dry-run: render template, return preview
 * POST   /:triggerId/run     — Manual fire: create execution + task immediately
 */
import type {
  ListTriggersResponse,
  TriggerResponse,
  TriggerStatus,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { CreateTriggerSchema, jsonValidator, UpdateTriggerSchema } from '../../schemas';
import { validateCronExpression } from '../../services/cron-utils';
import { cronToHumanReadable, cronToNextFire } from '../../services/cron-utils';
import { submitTriggeredTask } from '../../services/trigger-submit';
import { buildCronContext, renderTemplate } from '../../services/trigger-template';

const crudRoutes = new Hono<{ Bindings: Env }>();

/** Convert a DB trigger row to a TriggerResponse with human-readable cron. */
function toTriggerResponse(row: schema.TriggerRow): TriggerResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    status: row.status as TriggerStatus,
    sourceType: row.sourceType as TriggerResponse['sourceType'],
    cronExpression: row.cronExpression,
    cronTimezone: row.cronTimezone ?? 'UTC',
    skipIfRunning: row.skipIfRunning ?? true,
    promptTemplate: row.promptTemplate,
    agentProfileId: row.agentProfileId,
    taskMode: row.taskMode as TriggerResponse['taskMode'],
    vmSizeOverride: row.vmSizeOverride,
    maxConcurrent: row.maxConcurrent ?? 1,
    lastTriggeredAt: row.lastTriggeredAt,
    triggerCount: row.triggerCount ?? 0,
    nextFireAt: row.nextFireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cronHumanReadable: row.cronExpression
      ? cronToHumanReadable(row.cronExpression, row.cronTimezone ?? 'UTC')
      : undefined,
  };
}

// =============================================================================
// POST / — Create trigger
// =============================================================================
crudRoutes.post('/', jsonValidator(CreateTriggerSchema), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }

  await requireOwnedProject(db, projectId, userId);
  const body = c.req.valid('json');

  // Validate required fields
  const name = body.name?.trim();
  if (!name) {
    throw errors.badRequest('name is required');
  }

  const promptTemplate = body.promptTemplate?.trim();
  if (!promptTemplate) {
    throw errors.badRequest('promptTemplate is required');
  }

  // Validate template length
  const maxTemplateLength = parsePositiveInt(c.env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH);
  if (promptTemplate.length > maxTemplateLength) {
    throw errors.badRequest(`promptTemplate must be ${maxTemplateLength} characters or less`);
  }

  // Only cron sourceType is supported in Phase 0
  if (body.sourceType !== 'cron') {
    throw errors.badRequest('Only cron sourceType is supported currently');
  }

  // Validate cron expression (required for cron triggers)
  if (!body.cronExpression) {
    throw errors.badRequest('cronExpression is required for cron triggers');
  }

  const minInterval = parsePositiveInt(c.env.CRON_MIN_INTERVAL_MINUTES, DEFAULT_CRON_MIN_INTERVAL_MINUTES);
  const cronValidation = validateCronExpression(body.cronExpression, minInterval);
  if (!cronValidation.valid) {
    throw errors.badRequest(`Invalid cron expression: ${cronValidation.error}`);
  }

  // Validate timezone
  const timezone = body.cronTimezone ?? 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw errors.badRequest(`Invalid timezone: ${timezone}`);
  }

  // Validate agent profile if specified
  if (body.agentProfileId) {
    const [profile] = await db
      .select({ id: schema.agentProfiles.id })
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.id, body.agentProfileId),
          eq(schema.agentProfiles.projectId, projectId)
        )
      )
      .limit(1);
    if (!profile) {
      throw errors.notFound('Agent profile');
    }
  }

  // Check name uniqueness within project
  const [existingName] = await db
    .select({ id: schema.triggers.id })
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.projectId, projectId),
        eq(schema.triggers.name, name)
      )
    )
    .limit(1);
  if (existingName) {
    throw errors.conflict(`Trigger "${name}" already exists in this project`);
  }

  // Enforce MAX_TRIGGERS_PER_PROJECT
  const maxTriggers = parsePositiveInt(c.env.MAX_TRIGGERS_PER_PROJECT, DEFAULT_MAX_TRIGGERS_PER_PROJECT);
  const [triggerCount] = await db
    .select({ count: count() })
    .from(schema.triggers)
    .where(eq(schema.triggers.projectId, projectId));
  if ((triggerCount?.count ?? 0) >= maxTriggers) {
    throw errors.badRequest(`Maximum triggers per project (${maxTriggers}) reached`);
  }

  // Validate maxConcurrent
  const maxConcurrentLimit = parsePositiveInt(c.env.TRIGGER_MAX_CONCURRENT_LIMIT, DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT);
  const maxConcurrent = body.maxConcurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT;
  if (maxConcurrent < 1 || maxConcurrent > maxConcurrentLimit) {
    throw errors.badRequest(`maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
  }

  // Compute initial nextFireAt
  const nextFireAt = cronToNextFire(body.cronExpression, timezone);

  const id = ulid();
  const now = new Date().toISOString();

  await db.insert(schema.triggers).values({
    id,
    projectId,
    userId,
    name,
    description: body.description?.trim() ?? null,
    status: 'active',
    sourceType: body.sourceType,
    cronExpression: body.cronExpression,
    cronTimezone: timezone,
    skipIfRunning: body.skipIfRunning ?? true,
    promptTemplate,
    agentProfileId: body.agentProfileId ?? null,
    taskMode: body.taskMode ?? 'task',
    vmSizeOverride: body.vmSizeOverride ?? null,
    maxConcurrent,
    nextFireAt,
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.id, id))
    .limit(1);

  log.info('trigger.created', { triggerId: id, projectId, name, cronExpression: body.cronExpression });

  return c.json(toTriggerResponse(created!), 201);
});

// =============================================================================
// GET / — List triggers for project
// =============================================================================
crudRoutes.get('/', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }

  await requireOwnedProject(db, projectId, userId);

  const rows = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.projectId, projectId))
    .orderBy(desc(schema.triggers.createdAt));

  // Enrich with last execution status and total runs
  const triggerIds = rows.map((r) => r.id);
  const executionStats: Record<string, { lastStatus: string | null; totalRuns: number }> = {};

  if (triggerIds.length > 0) {
    // Get most recent execution per trigger
    for (const triggerId of triggerIds) {
      const [lastExec] = await db
        .select({ status: schema.triggerExecutions.status })
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.triggerId, triggerId))
        .orderBy(desc(schema.triggerExecutions.createdAt))
        .limit(1);

      const [countResult] = await db
        .select({ count: count() })
        .from(schema.triggerExecutions)
        .where(eq(schema.triggerExecutions.triggerId, triggerId));

      executionStats[triggerId] = {
        lastStatus: lastExec?.status ?? null,
        totalRuns: countResult?.count ?? 0,
      };
    }
  }

  const triggers: TriggerResponse[] = rows.map((row) => ({
    ...toTriggerResponse(row),
  }));

  const response: ListTriggersResponse = { triggers };
  return c.json(response);
});

// =============================================================================
// GET /:triggerId — Get trigger details + last 5 executions
// =============================================================================
crudRoutes.get('/:triggerId', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  await requireOwnedProject(db, projectId, userId);

  const [trigger] = await db
    .select()
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

  // Get last 5 executions
  const recentExecutions = await db
    .select()
    .from(schema.triggerExecutions)
    .where(eq(schema.triggerExecutions.triggerId, triggerId))
    .orderBy(desc(schema.triggerExecutions.createdAt))
    .limit(5);

  return c.json({
    ...toTriggerResponse(trigger),
    recentExecutions: recentExecutions.map((e) => ({
      id: e.id,
      triggerId: e.triggerId,
      projectId: e.projectId,
      status: e.status,
      skipReason: e.skipReason,
      taskId: e.taskId,
      eventType: e.eventType,
      renderedPrompt: e.renderedPrompt,
      errorMessage: e.errorMessage,
      scheduledAt: e.scheduledAt,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      sequenceNumber: e.sequenceNumber,
      createdAt: e.createdAt,
    })),
  });
});

// =============================================================================
// PATCH /:triggerId — Update trigger
// =============================================================================
crudRoutes.patch('/:triggerId', jsonValidator(UpdateTriggerSchema), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  await requireOwnedProject(db, projectId, userId);

  const [trigger] = await db
    .select()
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

  const body = c.req.valid('json');
  const updates: Partial<schema.NewTriggerRow> = {
    updatedAt: new Date().toISOString(),
  };

  // Validate and set name
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      throw errors.badRequest('name cannot be empty');
    }
    const maxNameLength = parsePositiveInt(c.env.TRIGGER_NAME_MAX_LENGTH, DEFAULT_TRIGGER_NAME_MAX_LENGTH);
    if (name.length > maxNameLength) {
      throw errors.badRequest(`name must be ${maxNameLength} characters or less`);
    }
    if (name !== trigger.name) {
      const [existingName] = await db
        .select({ id: schema.triggers.id })
        .from(schema.triggers)
        .where(
          and(
            eq(schema.triggers.projectId, projectId),
            eq(schema.triggers.name, name)
          )
        )
        .limit(1);
      if (existingName) {
        throw errors.conflict(`Trigger "${name}" already exists in this project`);
      }
    }
    updates.name = name;
  }

  if (body.description !== undefined) updates.description = body.description?.trim() ?? null;
  if (body.skipIfRunning !== undefined) updates.skipIfRunning = body.skipIfRunning;
  if (body.agentProfileId !== undefined) updates.agentProfileId = body.agentProfileId;
  if (body.taskMode !== undefined) updates.taskMode = body.taskMode;
  if (body.vmSizeOverride !== undefined) updates.vmSizeOverride = body.vmSizeOverride;

  if (body.maxConcurrent !== undefined) {
    const maxConcurrentLimit = parsePositiveInt(c.env.TRIGGER_MAX_CONCURRENT_LIMIT, DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT);
    if (body.maxConcurrent < 1 || body.maxConcurrent > maxConcurrentLimit) {
      throw errors.badRequest(`maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
    }
    updates.maxConcurrent = body.maxConcurrent;
  }

  if (body.promptTemplate !== undefined) {
    const maxTemplateLength = parsePositiveInt(c.env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH);
    if (body.promptTemplate.length > maxTemplateLength) {
      throw errors.badRequest(`promptTemplate must be ${maxTemplateLength} characters or less`);
    }
    updates.promptTemplate = body.promptTemplate;
  }

  // Track whether we need to recompute nextFireAt
  let recomputeNextFire = false;
  let newCronExpression = trigger.cronExpression;
  let newTimezone = trigger.cronTimezone ?? 'UTC';

  if (body.cronExpression !== undefined) {
    const minInterval = parsePositiveInt(c.env.CRON_MIN_INTERVAL_MINUTES, DEFAULT_CRON_MIN_INTERVAL_MINUTES);
    const validation = validateCronExpression(body.cronExpression, minInterval);
    if (!validation.valid) {
      throw errors.badRequest(`Invalid cron expression: ${validation.error}`);
    }
    updates.cronExpression = body.cronExpression;
    newCronExpression = body.cronExpression;
    recomputeNextFire = true;
  }

  if (body.cronTimezone !== undefined) {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: body.cronTimezone });
    } catch {
      throw errors.badRequest(`Invalid timezone: ${body.cronTimezone}`);
    }
    updates.cronTimezone = body.cronTimezone;
    newTimezone = body.cronTimezone;
    recomputeNextFire = true;
  }

  // Handle status changes
  if (body.status !== undefined) {
    updates.status = body.status;
    if (body.status === 'paused' || body.status === 'disabled') {
      updates.nextFireAt = null;
    } else if (body.status === 'active' && (trigger.status === 'paused' || trigger.status === 'disabled')) {
      // Resuming — recompute nextFireAt
      recomputeNextFire = true;
    }
  }

  // Recompute nextFireAt if needed and trigger is/will be active
  const effectiveStatus = (body.status ?? trigger.status) as TriggerStatus;
  if (recomputeNextFire && effectiveStatus === 'active' && newCronExpression) {
    updates.nextFireAt = cronToNextFire(newCronExpression, newTimezone);
  }

  await db
    .update(schema.triggers)
    .set(updates)
    .where(eq(schema.triggers.id, triggerId));

  const [updated] = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.id, triggerId))
    .limit(1);

  log.info('trigger.updated', { triggerId, projectId, fields: Object.keys(body) });

  return c.json(toTriggerResponse(updated!));
});

// =============================================================================
// DELETE /:triggerId — Delete trigger + cascade executions
// =============================================================================
crudRoutes.delete('/:triggerId', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  await requireOwnedProject(db, projectId, userId);

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

  // Cascade delete executions first, then trigger
  await db.delete(schema.triggerExecutions).where(eq(schema.triggerExecutions.triggerId, triggerId));
  await db.delete(schema.triggers).where(eq(schema.triggers.id, triggerId));

  log.info('trigger.deleted', { triggerId, projectId });

  return c.json({ success: true });
});

// =============================================================================
// POST /:triggerId/test — Dry-run: render template with current time
// =============================================================================
crudRoutes.post('/:triggerId/test', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  const project = await requireOwnedProject(db, projectId, userId);

  const [trigger] = await db
    .select()
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

  const now = new Date();
  const executionId = ulid(); // Fake execution ID for preview
  const sequenceNumber = (trigger.triggerCount ?? 0) + 1;

  const context = buildCronContext(
    {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      triggerCount: trigger.triggerCount ?? 0,
      cronTimezone: trigger.cronTimezone ?? 'UTC',
      projectId: trigger.projectId,
    },
    now,
    project.name,
    executionId,
    sequenceNumber
  );

  const result = renderTemplate(trigger.promptTemplate, context as unknown as Record<string, unknown>);

  return c.json({
    renderedPrompt: result.rendered,
    warnings: result.warnings,
    context,
  });
});

// =============================================================================
// POST /:triggerId/run — Manual fire: create execution + task
// =============================================================================
crudRoutes.post('/:triggerId/run', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  const project = await requireOwnedProject(db, projectId, userId);

  const [trigger] = await db
    .select()
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

  // Check concurrent execution limit
  const [activeCount] = await db
    .select({ count: count() })
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.triggerId, triggerId),
        inArray(schema.triggerExecutions.status, ['queued', 'running'])
      )
    );

  const maxConcurrent = trigger.maxConcurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT;
  if ((activeCount?.count ?? 0) >= maxConcurrent) {
    throw errors.conflict(`Concurrent execution limit (${maxConcurrent}) reached for this trigger`);
  }

  const now = new Date();
  const executionId = ulid();
  const sequenceNumber = (trigger.triggerCount ?? 0) + 1;

  // Render template
  const context = buildCronContext(
    {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      triggerCount: trigger.triggerCount ?? 0,
      cronTimezone: trigger.cronTimezone ?? 'UTC',
      projectId: trigger.projectId,
    },
    now,
    project.name,
    executionId,
    sequenceNumber
  );

  const rendered = renderTemplate(trigger.promptTemplate, context as unknown as Record<string, unknown>);

  // Create execution record
  await db.insert(schema.triggerExecutions).values({
    id: executionId,
    triggerId,
    projectId,
    status: 'queued',
    eventType: 'manual',
    renderedPrompt: rendered.rendered,
    scheduledAt: now.toISOString(),
    startedAt: now.toISOString(),
    sequenceNumber,
    createdAt: now.toISOString(),
  });

  // Submit the task
  try {
    const result = await submitTriggeredTask(c.env, {
      triggerId,
      triggerExecutionId: executionId,
      projectId,
      userId: trigger.userId,
      renderedPrompt: rendered.rendered,
      triggeredBy: 'cron',
      agentProfileId: trigger.agentProfileId,
      taskMode: (trigger.taskMode ?? 'task') as 'task' | 'conversation',
      vmSizeOverride: trigger.vmSizeOverride,
      triggerName: trigger.name,
    });

    // Update execution with taskId and running status
    await db
      .update(schema.triggerExecutions)
      .set({ taskId: result.taskId, status: 'running' })
      .where(eq(schema.triggerExecutions.id, executionId));

    // Update trigger metadata
    await db
      .update(schema.triggers)
      .set({
        lastTriggeredAt: now.toISOString(),
        triggerCount: sequenceNumber,
        updatedAt: now.toISOString(),
      })
      .where(eq(schema.triggers.id, triggerId));

    log.info('trigger.manual_run', { triggerId, executionId, taskId: result.taskId, projectId });

    return c.json({
      executionId,
      taskId: result.taskId,
      sessionId: result.sessionId,
      branchName: result.branchName,
      renderedPrompt: rendered.rendered,
    }, 202);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.triggerExecutions)
      .set({
        status: 'failed',
        errorMessage: errorMsg,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.triggerExecutions.id, executionId));

    log.error('trigger.manual_run_failed', { triggerId, executionId, projectId, error: errorMsg });
    throw err;
  }
});

// =============================================================================
// DELETE /api/projects/:projectId/triggers/:triggerId/executions/:executionId
// Delete a single execution record (only non-running executions)
// =============================================================================
crudRoutes.delete('/:triggerId/executions/:executionId', async (c) => {
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

  // Verify the execution belongs to this trigger and project
  const [execution] = await db
    .select()
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.id, executionId),
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId)
      )
    )
    .limit(1);

  if (!execution) {
    throw errors.notFound('Trigger execution');
  }

  // Prevent deleting actively running executions
  if (execution.status === 'running') {
    throw errors.conflict('Cannot delete an actively running execution');
  }

  await db
    .delete(schema.triggerExecutions)
    .where(eq(schema.triggerExecutions.id, executionId));

  log.info('trigger.execution_deleted', { triggerId, executionId, projectId });

  return c.json({ success: true });
});

// =============================================================================
// POST /api/projects/:projectId/triggers/:triggerId/executions/cleanup
// Force-fail all stuck queued executions
// =============================================================================
crudRoutes.post('/:triggerId/executions/cleanup', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !triggerId) {
    throw errors.badRequest('projectId and triggerId are required');
  }

  await requireOwnedProject(db, projectId, userId);

  // Verify the trigger exists
  const [trigger] = await db
    .select()
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

  // Find all stuck queued executions (running executions may have active tasks — use cron sweep for those)
  const stuckExecutions = await db
    .select({ id: schema.triggerExecutions.id, status: schema.triggerExecutions.status })
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId),
        eq(schema.triggerExecutions.status, 'queued')
      )
    );

  if (stuckExecutions.length === 0) {
    return c.json({ cleaned: 0 });
  }

  const now = new Date().toISOString();
  const stuckIds = stuckExecutions.map((e) => e.id);

  await db
    .update(schema.triggerExecutions)
    .set({
      status: 'failed',
      errorMessage: 'Manually cleaned up by user',
      completedAt: now,
    })
    .where(
      and(
        inArray(schema.triggerExecutions.id, stuckIds),
        eq(schema.triggerExecutions.triggerId, triggerId)
      )
    );

  log.info('trigger.executions_cleaned', {
    triggerId,
    projectId,
    cleaned: stuckExecutions.length,
    statuses: stuckExecutions.map((e) => e.status),
  });

  return c.json({ cleaned: stuckExecutions.length });
});

export { crudRoutes };
