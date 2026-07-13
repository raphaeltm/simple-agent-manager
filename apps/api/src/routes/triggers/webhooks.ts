import type { TriggerPreviewResponse, WebhookCredential } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parsePositiveInt } from '../../lib/route-helpers';
import { requireRouteParam } from '../../lib/route-helpers';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { jsonValidator, TriggerPreviewSchema } from '../../schemas';
import { renderTemplate } from '../../services/trigger-template';
import { getWebhookTriggerLimits } from '../../services/webhook-trigger-config';
import {
  buildWebhookContext,
  evaluateWebhookFilters,
  selectWebhookHeaders,
} from '../../services/webhook-trigger-payload';
import {
  listWebhookDeliveries,
  rotateWebhookToken,
  toWebhookTriggerConfig,
} from '../../services/webhook-trigger-store';
import { requireProjectTaskRead, requireProjectTaskWrite } from '../task-project-auth';

const webhookRoutes = new Hono<{ Bindings: Env }>();

function endpointUrl(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/webhooks/ingest`;
}

function credential(requestUrl: string, token: string): WebhookCredential {
  return { endpointUrl: endpointUrl(requestUrl), token, headerName: 'Authorization' };
}

async function loadWebhookTrigger(env: Env, projectId: string, triggerId: string) {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      trigger: schema.triggers,
      config: schema.webhookTriggerConfigs,
      projectName: schema.projects.name,
    })
    .from(schema.triggers)
    .innerJoin(
      schema.webhookTriggerConfigs,
      eq(schema.triggers.id, schema.webhookTriggerConfigs.triggerId)
    )
    .innerJoin(schema.projects, eq(schema.triggers.projectId, schema.projects.id))
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)))
    .get();
  if (!row) throw errors.notFound('Webhook trigger');
  return { ...row, config: toWebhookTriggerConfig(row.config) };
}

webhookRoutes.post('/:triggerId/webhook/rotate', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const token = await rotateWebhookToken(c.env, projectId, triggerId);
  if (!token) throw errors.notFound('Webhook trigger');
  return c.json({ webhookCredential: credential(c.req.url, token.token) });
});

webhookRoutes.get('/:triggerId/webhook/deliveries', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  await loadWebhookTrigger(c.env, projectId, triggerId);
  const limit = Math.min(parsePositiveInt(c.req.query('limit'), 25), 100);
  return c.json(await listWebhookDeliveries(c.env, triggerId, c.req.query('cursor'), limit));
});

webhookRoutes.post(
  '/:triggerId/webhook/preview',
  jsonValidator(TriggerPreviewSchema),
  async (c) => {
    const projectId = requireRouteParam(c, 'projectId');
    const triggerId = requireRouteParam(c, 'triggerId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
    const { trigger, config, projectName } = await loadWebhookTrigger(c.env, projectId, triggerId);
    const input = c.req.valid('json');
    const body = input.payload ?? {};
    const filterResult = evaluateWebhookFilters(
      body,
      config.filters,
      config.filterMode,
      getWebhookTriggerLimits(c.env).maxFilterPathDepth
    );
    const context = buildWebhookContext({
      body,
      headers: selectWebhookHeaders(input.headers ?? {}, config.includedHeaders),
      receivedAt: new Date().toISOString(),
      deliveryId: 'preview',
      sourceLabel: config.sourceLabel,
      trigger,
      projectName,
      executionId: 'preview',
      sequenceNumber: trigger.nextExecutionSequence,
    });
    const rendered = renderTemplate(
      trigger.promptTemplate,
      context as unknown as Record<string, unknown>
    );
    const response: TriggerPreviewResponse = {
      renderedPrompt: rendered.rendered,
      warnings: rendered.warnings,
      context: context as unknown as Record<string, unknown>,
      filterResult,
    };
    return c.json(response);
  }
);

export { credential as buildWebhookCredential, webhookRoutes };
