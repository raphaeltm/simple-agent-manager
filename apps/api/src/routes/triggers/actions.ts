/** Authenticated trigger execution actions. */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { requireRouteParam } from '../../lib/route-helpers';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  buildTriggerActionContext,
  type TriggerActionSourceConfig,
} from '../../services/trigger-action-context';
import { admitAndSubmitTriggerExecution } from '../../services/trigger-admission';
import { renderTemplate } from '../../services/trigger-template';
import { toWebhookTriggerConfig } from '../../services/webhook-trigger-store';
import { requireProjectTaskRead, requireProjectTaskWrite } from '../task-project-auth';

const actionRoutes = new Hono<{ Bindings: Env }>();

async function loadTrigger(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  triggerId: string
) {
  const trigger = await db
    .select()
    .from(schema.triggers)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)))
    .get();
  if (!trigger) throw errors.notFound('Trigger');
  return trigger;
}

async function loadSourceConfig(
  db: ReturnType<typeof drizzle<typeof schema>>,
  trigger: schema.TriggerRow
): Promise<TriggerActionSourceConfig> {
  if (trigger.sourceType === 'webhook') {
    const row = await db
      .select()
      .from(schema.webhookTriggerConfigs)
      .where(eq(schema.webhookTriggerConfigs.triggerId, trigger.id))
      .get();
    if (!row) throw errors.notFound('Webhook trigger');
    return { sourceType: 'webhook', config: toWebhookTriggerConfig(row) };
  }
  if (trigger.sourceType === 'github') {
    const row = await db
      .select({ eventType: schema.githubTriggerConfigs.eventType })
      .from(schema.githubTriggerConfigs)
      .where(eq(schema.githubTriggerConfigs.triggerId, trigger.id))
      .get();
    if (!row) throw errors.notFound('GitHub trigger');
    return { sourceType: 'github', eventType: row.eventType };
  }
  return { sourceType: 'cron' };
}

actionRoutes.post('/:triggerId/test', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  const trigger = await loadTrigger(db, projectId, triggerId);
  const now = new Date();
  const context = buildTriggerActionContext({
    trigger,
    project,
    source: await loadSourceConfig(db, trigger),
    now,
    executionId: ulid(),
    sequenceNumber: trigger.nextExecutionSequence,
  });
  const result = renderTemplate(
    trigger.promptTemplate,
    expectJsonRecord(context, 'trigger.template_context')
  );
  return c.json({ renderedPrompt: result.rendered, warnings: result.warnings, context });
});

actionRoutes.post('/:triggerId/run', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const trigger = await loadTrigger(db, projectId, triggerId);
  const input: unknown = await c.req.json().catch(() => ({}));
  const preview =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { payload?: Record<string, unknown>; headers?: Record<string, string> })
      : {};
  const source = await loadSourceConfig(db, trigger);
  const now = new Date();
  const admission = await admitAndSubmitTriggerExecution(c.env, {
    trigger,
    eventType: 'manual',
    triggeredBy: 'user',
    allowPaused: true,
    renderPrompt: (executionId, sequenceNumber) => {
      const context = buildTriggerActionContext({
        trigger,
        project,
        source,
        now,
        executionId,
        sequenceNumber,
        preview,
      });
      return renderTemplate(trigger.promptTemplate, context as unknown as Record<string, unknown>)
        .rendered;
    },
  });
  if (admission.outcome === 'submitted' || admission.outcome === 'pending') {
    log.info('trigger.manual_run', {
      triggerId,
      projectId,
      taskId: admission.taskId,
      submissionPending: admission.outcome === 'pending',
    });
    return c.json(admission, 202);
  }
  if (admission.outcome === 'skipped') {
    throw errors.conflict(`Trigger execution skipped: ${admission.reason}`);
  }
  if (admission.outcome === 'inactive') throw errors.conflict(`Trigger is ${admission.reason}`);
  throw errors.internal('Trigger submission failed');
});

actionRoutes.delete('/:triggerId/executions/:executionId', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const executionId = requireRouteParam(c, 'executionId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const execution = await db
    .select()
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.id, executionId),
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId)
      )
    )
    .get();
  if (!execution) throw errors.notFound('Trigger execution');
  if (execution.status === 'running') {
    throw errors.conflict('Cannot delete an actively running execution');
  }
  await db
    .delete(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.id, executionId),
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId)
      )
    );
  return c.json({ success: true });
});

actionRoutes.post('/:triggerId/executions/cleanup', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  await loadTrigger(db, projectId, triggerId);
  const stuck = await db
    .select({ id: schema.triggerExecutions.id })
    .from(schema.triggerExecutions)
    .where(
      and(
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId),
        eq(schema.triggerExecutions.status, 'queued')
      )
    );
  if (!stuck.length) return c.json({ cleaned: 0 });
  await db
    .update(schema.triggerExecutions)
    .set({
      status: 'failed',
      errorMessage: 'Manually cleaned up by user',
      completedAt: new Date().toISOString(),
    })
    .where(
      and(
        inArray(
          schema.triggerExecutions.id,
          stuck.map((execution) => execution.id)
        ),
        eq(schema.triggerExecutions.triggerId, triggerId),
        eq(schema.triggerExecutions.projectId, projectId)
      )
    );
  return c.json({ cleaned: stuck.length });
});

export { actionRoutes };
