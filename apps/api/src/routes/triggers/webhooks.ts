import {
  isWebhookSignedScheme,
  type SetWebhookSigningSecretResponse,
  type TriggerPreviewResponse,
  type WebhookCredential,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt, requireRouteParam } from '../../lib/route-helpers';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { buildTrustedApiUrl } from '../../lib/trusted-origins';
import { getAuth, rejectAgentSignInSession } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { jsonValidator, TriggerPreviewSchema } from '../../schemas';
import { renderTemplate } from '../../services/trigger-template';
import {
  setWebhookSigningSecret,
  validateWebhookSigningSecret,
} from '../../services/webhook-signed-store';
import { getWebhookTriggerLimits } from '../../services/webhook-trigger-config';
import {
  toWebhookTriggerConfig,
  WEBHOOK_BEARER_INGEST_PATH,
} from '../../services/webhook-trigger-config-rows';
import {
  buildWebhookContext,
  evaluateWebhookFilters,
  selectWebhookHeaders,
} from '../../services/webhook-trigger-payload';
import {
  InvalidWebhookDeliveryCursorError,
  listWebhookDeliveries,
  rotateWebhookToken,
} from '../../services/webhook-trigger-store';
import { requireProjectTaskRead, requireProjectTaskWrite } from '../task-project-auth';

const webhookRoutes = new Hono<{ Bindings: Env }>();

function endpointUrl(env: Env): string {
  return buildTrustedApiUrl(env, WEBHOOK_BEARER_INGEST_PATH);
}

function credential(env: Env, token: string): WebhookCredential {
  return { endpointUrl: endpointUrl(env), token, headerName: 'Authorization' };
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
  return { ...row, config: toWebhookTriggerConfig(row.config, env) };
}

webhookRoutes.post('/:triggerId/webhook/rotate', rejectAgentSignInSession(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const token = await rotateWebhookToken(c.env, projectId, triggerId);
  if (!token) throw errors.notFound('Webhook trigger');
  c.header('Cache-Control', 'private, no-store');
  return c.json({ webhookCredential: credential(c.env, token.token) });
});

/**
 * Saves or replaces the signing secret of a signed automation. Write-only: the value is
 * encrypted at rest, no endpoint returns it, and it is never echoed in an error or a log line.
 * The body is read by hand instead of through the shared validator, whose messages quote the
 * offending value.
 */
// An agent sign-in session must not install a lasting credential: whoever knows the signing
// secret can start runs as the owner after that session has expired (same as /rotate).
webhookRoutes.put('/:triggerId/webhook/signing-secret', rejectAgentSignInSession(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getAuth(c).user.id;
  await requireProjectTaskWrite(db, projectId, userId);
  const { config } = await loadWebhookTrigger(c.env, projectId, triggerId);
  if (!isWebhookSignedScheme(config.verification.scheme)) {
    throw errors.badRequest('This automation uses a SAM token, not a signing secret');
  }
  let parsed: unknown = null;
  try {
    parsed = await c.req.json();
  } catch {
    parsed = null;
  }
  const checked = validateWebhookSigningSecret(maybeJsonRecord(parsed)?.secret);
  if (!checked.ok) throw errors.badRequest(checked.message);
  const signingSecret = await setWebhookSigningSecret(c.env, {
    projectId,
    triggerId,
    userId,
    secret: checked.secret,
  });
  if (!signingSecret) throw errors.notFound('Webhook trigger');
  log.info('trigger.webhook_signing_secret_saved', { triggerId, projectId, userId });
  c.header('Cache-Control', 'private, no-store');
  const response: SetWebhookSigningSecretResponse = { signingSecret };
  return c.json(response);
});

webhookRoutes.get('/:triggerId/webhook/deliveries', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  await loadWebhookTrigger(c.env, projectId, triggerId);
  const limits = getWebhookTriggerLimits(c.env);
  const limit = Math.min(
    parsePositiveInt(c.req.query('limit'), limits.deliveryDefaultPageSize),
    limits.deliveryMaxPageSize
  );
  try {
    return c.json(await listWebhookDeliveries(c.env, triggerId, c.req.query('cursor'), limit));
  } catch (error) {
    if (error instanceof InvalidWebhookDeliveryCursorError) {
      throw errors.badRequest(error.message);
    }
    throw error;
  }
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
