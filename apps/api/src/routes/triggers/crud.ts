/** Authenticated trigger CRUD. Execution actions live in actions.ts. */
import type {
  CreateTriggerResponse,
  GitHubTriggerEventType,
  ListTriggersResponse,
  TriggerResponse,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, type sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt, requireRouteParam } from '../../lib/route-helpers';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { CreateTriggerSchema, jsonValidator, UpdateTriggerSchema } from '../../schemas';
import {
  loadEmailTriggerConfig,
  resolveAllowedSenders,
  toEmailTriggerConfig,
} from '../../services/agent-email/trigger-config';
import { buildCredentialAttributionForTriggers } from '../../services/credential-attribution-health';
import { cronToNextFire } from '../../services/cron-utils';
import {
  assertGitHubTriggerConfigExists,
  githubTriggerConfigUpdate,
} from '../../services/github-trigger-config';
import { parseGitHubTriggerFiltersJson } from '../../services/github-trigger-filter';
import { getProjectMultiplayerState } from '../../services/project-multiplayer';
import {
  ResourceRequirementsValidationError,
  serializeResourceRequirementsInput,
} from '../../services/resource-requirements-input';
import { clearTriggerPageCaches } from '../../services/trigger-cache';
import {
  assertKeepsAgentProfile,
  createTrigger,
  validateCron,
  validateReferences,
  validateTriggerSourceFields,
} from '../../services/trigger-create';
import { listTriggerRows, toTriggerResponse } from '../../services/trigger-read';
import { triggerStatusUpdates } from '../../services/trigger-status';
import {
  getWebhookTriggerLimits,
  validateWebhookTriggerConfig,
} from '../../services/webhook-trigger-config';
import {
  mergeWebhookConfig,
  toWebhookTriggerConfig,
  webhookConfigUpdateValues,
} from '../../services/webhook-trigger-store';
import { requireProjectTaskRead, requireProjectTaskWrite } from '../task-project-auth';
import { buildWebhookCredential } from './webhooks';

const crudRoutes = new Hono<{ Bindings: Env }>();
type Database = ReturnType<typeof drizzle<typeof schema>>;

async function attribution(
  db: Database,
  env: Env,
  project: schema.Project,
  triggers: schema.TriggerRow[]
) {
  const [multiplayer, checks] = await Promise.all([
    getProjectMultiplayerState(db, project.id, new Date(), env),
    buildCredentialAttributionForTriggers({
      db,
      project,
      triggers,
      defaultAgentType: env.DEFAULT_TASK_AGENT_TYPE || 'opencode',
    }),
  ]);
  return new Map(
    triggers.map((trigger) => {
      const triggerChecks = checks.get(trigger.id) ?? [];
      return [
        trigger.id,
        {
          multiplayerActive: multiplayer.multiplayerActive,
          hasPersonalWarning: triggerChecks.some((check) => check.source === 'personal'),
          checks: triggerChecks,
        },
      ] as const;
    })
  );
}

function triggerResourceRequirementsJson(body: {
  resourceRequirements?: unknown;
  resourceRequirementsJson?: string | null;
}): string | null {
  try {
    if (body.resourceRequirements !== undefined) {
      return serializeResourceRequirementsInput(body.resourceRequirements);
    }
    return serializeResourceRequirementsInput(
      body.resourceRequirementsJson,
      'resourceRequirementsJson'
    );
  } catch (err) {
    if (err instanceof ResourceRequirementsValidationError) {
      throw errors.badRequest(err.message);
    }
    throw err;
  }
}

async function enrichTrigger(
  db: Database,
  env: Env,
  row: schema.TriggerRow,
  credentialAttribution?: TriggerResponse['credentialAttribution']
): Promise<TriggerResponse> {
  const response = toTriggerResponse(row);
  response.credentialAttribution = credentialAttribution;
  if (row.sourceType === 'github')
    response.queueStats = (await readQueueStats(env, row.projectId)).get(row.id) ?? {
      queued: 0,
      routed: 0,
      dropped: 0,
    };
  if (row.sourceType === 'github') {
    const config = await db
      .select()
      .from(schema.githubTriggerConfigs)
      .where(eq(schema.githubTriggerConfigs.triggerId, row.id))
      .get();
    if (config) {
      const parsedFilters = parseGitHubTriggerFiltersJson(config.filtersJson);
      if (!parsedFilters.valid) {
        log.warn('trigger.github_filters_invalid', { triggerId: row.id });
      }
      response.githubConfig = {
        eventType: config.eventType as GitHubTriggerEventType,
        filters: parsedFilters.filters,
        subjectAffinity: config.subjectAffinity,
        queueMaxPending: config.queueMaxPending,
        queueTtlSeconds: config.queueTtlSeconds,
      };
    }
  }
  if (row.sourceType === 'webhook') {
    const config = await db
      .select()
      .from(schema.webhookTriggerConfigs)
      .where(eq(schema.webhookTriggerConfigs.triggerId, row.id))
      .get();
    if (config) response.webhookConfig = toWebhookTriggerConfig(config);
  }
  if (row.sourceType === 'email') {
    response.emailConfig = await loadEmailTriggerConfig(db, env, row.id);
  }
  return response;
}

crudRoutes.post('/', jsonValidator(CreateTriggerSchema), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getAuth(c).user.id;
  const project = await requireProjectTaskWrite(db, projectId, userId);
  const body = c.req.valid('json');
  const { created, webhookToken } = await createTrigger(db, c.env, project, userId, body);
  const id = created.id;
  clearTriggerPageCaches(projectId);
  const attributionById = await attribution(db, c.env, project, [created]);
  const response: CreateTriggerResponse = {
    ...(await enrichTrigger(db, c.env, created, attributionById.get(id))),
    webhookCredential: webhookToken ? buildWebhookCredential(c.env, webhookToken.token) : undefined,
  };
  log.info('trigger.created', { triggerId: id, projectId, sourceType: body.sourceType });
  if (webhookToken) c.header('Cache-Control', 'private, no-store');
  return c.json(response, 201);
});

crudRoutes.get('/', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  const rows = await listTriggerRows(db, projectId);
  const ids = rows.map((row) => row.id);
  const emailIds = rows.filter((row) => row.sourceType === 'email').map((row) => row.id);
  const [githubConfigs, webhookConfigs, emailConfigs, attributionById] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(schema.githubTriggerConfigs)
          .where(inArray(schema.githubTriggerConfigs.triggerId, ids))
      : [],
    ids.length
      ? db
          .select()
          .from(schema.webhookTriggerConfigs)
          .where(inArray(schema.webhookTriggerConfigs.triggerId, ids))
      : [],
    emailIds.length
      ? db
          .select()
          .from(schema.triggerEmailConfigs)
          .where(inArray(schema.triggerEmailConfigs.triggerId, emailIds))
      : [],
    attribution(db, c.env, project, rows),
  ]);
  const githubById = new Map(githubConfigs.map((config) => [config.triggerId, config]));
  const webhookById = new Map(webhookConfigs.map((config) => [config.triggerId, config]));
  const emailById = new Map(emailConfigs.map((config) => [config.triggerId, config]));
  const queueStats = githubConfigs.length ? await readQueueStats(c.env, projectId) : new Map();
  const triggers = rows.map((row) => {
    const response = toTriggerResponse(row);
    response.credentialAttribution = attributionById.get(row.id);
    const github = githubById.get(row.id);
    if (github)
      response.queueStats = queueStats.get(row.id) ?? { queued: 0, routed: 0, dropped: 0 };
    if (github) {
      const parsedFilters = parseGitHubTriggerFiltersJson(github.filtersJson);
      if (!parsedFilters.valid) {
        log.warn('trigger.github_filters_invalid', { triggerId: row.id });
      }
      response.githubConfig = {
        eventType: github.eventType as GitHubTriggerEventType,
        filters: parsedFilters.filters,
        subjectAffinity: github.subjectAffinity,
        queueMaxPending: github.queueMaxPending,
        queueTtlSeconds: github.queueTtlSeconds,
      };
    }
    const webhook = webhookById.get(row.id);
    if (webhook) response.webhookConfig = toWebhookTriggerConfig(webhook);
    const email = emailById.get(row.id);
    if (email) response.emailConfig = toEmailTriggerConfig(email, c.env.BASE_DOMAIN);
    return response;
  });
  const response: ListTriggersResponse = { triggers };
  return c.json(response);
});

crudRoutes.get('/:triggerId', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  const trigger = await db
    .select()
    .from(schema.triggers)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)))
    .get();
  if (!trigger) throw errors.notFound('Trigger');
  const attributionById = await attribution(db, c.env, project, [trigger]);
  const recentExecutions = await db
    .select()
    .from(schema.triggerExecutions)
    .where(eq(schema.triggerExecutions.triggerId, triggerId))
    .orderBy(desc(schema.triggerExecutions.createdAt))
    .limit(5);
  return c.json({
    ...(await enrichTrigger(db, c.env, trigger, attributionById.get(triggerId))),
    recentExecutions,
  });
});

crudRoutes.patch('/:triggerId', jsonValidator(UpdateTriggerSchema), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const trigger = await db
    .select()
    .from(schema.triggers)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)))
    .get();
  if (!trigger) throw errors.notFound('Trigger');
  const body = c.req.valid('json');
  validateTriggerSourceFields(trigger.sourceType, body);
  if (body.webhookConfig && trigger.sourceType !== 'webhook') {
    throw errors.badRequest('webhookConfig is only valid for webhook triggers');
  }
  assertKeepsAgentProfile(trigger.sourceType, body.agentProfileId);
  const emailAllowedSenders = body.emailConfig?.allowedSenders
    ? await resolveAllowedSenders(db, c.env, trigger.userId, body.emailConfig.allowedSenders)
    : undefined;
  await validateReferences(db, projectId, body.agentProfileId, body.skillId);
  const now = new Date().toISOString();
  const updates: Omit<Partial<schema.NewTriggerRow>, 'autoPauseResetSequence'> & {
    autoPauseResetSequence?: number | ReturnType<typeof sql>;
  } = { updatedAt: now };
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (
      !name ||
      name.length > parsePositiveInt(c.env.TRIGGER_NAME_MAX_LENGTH, DEFAULT_TRIGGER_NAME_MAX_LENGTH)
    ) {
      throw errors.badRequest('Invalid trigger name');
    }
    updates.name = name;
  }
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.promptTemplate !== undefined) {
    const promptTemplate = body.promptTemplate.trim();
    if (!promptTemplate) throw errors.badRequest('promptTemplate cannot be empty');
    if (
      promptTemplate.length >
      parsePositiveInt(c.env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH)
    ) {
      throw errors.badRequest('promptTemplate is too long');
    }
    updates.promptTemplate = promptTemplate;
  }
  if (body.skipIfRunning !== undefined) updates.skipIfRunning = body.skipIfRunning;
  if (body.agentProfileId !== undefined) updates.agentProfileId = body.agentProfileId;
  if (body.skillId !== undefined) updates.skillId = body.skillId;
  if (body.taskMode !== undefined) updates.taskMode = body.taskMode;
  if (body.vmSizeOverride !== undefined) updates.vmSizeOverride = body.vmSizeOverride;
  if (body.resourceRequirements !== undefined || body.resourceRequirementsJson !== undefined) {
    updates.resourceRequirementsJson = triggerResourceRequirementsJson(body);
  }
  if (body.maxConcurrent !== undefined) {
    const maxConcurrentLimit = parsePositiveInt(
      c.env.TRIGGER_MAX_CONCURRENT_LIMIT,
      DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT
    );
    if (body.maxConcurrent < 1 || body.maxConcurrent > maxConcurrentLimit) {
      throw errors.badRequest(`maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
    }
    updates.maxConcurrent = body.maxConcurrent;
  }
  if (body.cronExpression !== undefined || body.cronTimezone !== undefined) {
    const expression = body.cronExpression ?? trigger.cronExpression ?? undefined;
    const timezone = body.cronTimezone ?? trigger.cronTimezone ?? 'UTC';
    validateCron(c.env, expression, timezone);
    if (!expression) {
      // validateCron() above already throws when expression is falsy —
      // should never happen.
      throw errors.badRequest('cronExpression is required for cron triggers');
    }
    updates.cronExpression = expression;
    updates.cronTimezone = timezone;
    if ((body.status ?? trigger.status) === 'active') {
      updates.nextFireAt = cronToNextFire(expression, timezone);
    }
  }
  if (body.status !== undefined) {
    // The schedule the row will have after this update: a request that changes the cron and
    // resumes at once must take its next fire from the new cron.
    const schedule = {
      ...trigger,
      cronExpression: updates.cronExpression ?? trigger.cronExpression,
      cronTimezone: updates.cronTimezone ?? trigger.cronTimezone,
    };
    Object.assign(updates, triggerStatusUpdates(schedule, body.status));
  }
  let effectiveWebhookConfig: ReturnType<typeof mergeWebhookConfig> | undefined;
  if (body.webhookConfig) {
    const current = await db
      .select()
      .from(schema.webhookTriggerConfigs)
      .where(eq(schema.webhookTriggerConfigs.triggerId, triggerId))
      .get();
    if (!current) throw errors.notFound('Webhook trigger');
    effectiveWebhookConfig = mergeWebhookConfig(
      toWebhookTriggerConfig(current),
      body.webhookConfig
    );
    const configError = validateWebhookTriggerConfig(
      effectiveWebhookConfig,
      getWebhookTriggerLimits(c.env)
    );
    if (configError) throw errors.badRequest(configError);
  }
  if (body.githubConfig) await assertGitHubTriggerConfigExists(db, triggerId);
  const triggerUpdate = db
    .update(schema.triggers)
    .set(updates)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)));
  if (body.githubConfig) {
    await db.batch([
      triggerUpdate,
      githubTriggerConfigUpdate(db, triggerId, body.githubConfig, now),
    ]);
  } else if (emailAllowedSenders) {
    await db.batch([
      triggerUpdate,
      db
        .update(schema.triggerEmailConfigs)
        .set({ allowedSendersJson: JSON.stringify(emailAllowedSenders), updatedAt: now })
        .where(eq(schema.triggerEmailConfigs.triggerId, triggerId)),
    ]);
  } else if (effectiveWebhookConfig) {
    await db.batch([
      triggerUpdate,
      db
        .update(schema.webhookTriggerConfigs)
        .set(webhookConfigUpdateValues(effectiveWebhookConfig, now))
        .where(eq(schema.webhookTriggerConfigs.triggerId, triggerId)),
    ]);
  } else {
    await triggerUpdate;
  }
  const updated = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.id, triggerId))
    .get();
  if (!updated) throw errors.notFound('Trigger');
  clearTriggerPageCaches(projectId);
  const attributionById = await attribution(db, c.env, project, [updated]);
  log.info('trigger.updated', { triggerId, projectId, fields: Object.keys(body) });
  return c.json(await enrichTrigger(db, c.env, updated, attributionById.get(triggerId)));
});

crudRoutes.delete('/:triggerId', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const triggerId = requireRouteParam(c, 'triggerId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectTaskWrite(db, projectId, getAuth(c).user.id);
  const result = await db
    .delete(schema.triggers)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)));
  if (!(result as { meta?: { changes?: number } }).meta?.changes) throw errors.notFound('Trigger');
  clearTriggerPageCaches(projectId);
  log.info('trigger.deleted', { triggerId, projectId });
  return c.json({ success: true });
});

export { crudRoutes };

async function readQueueStats(env: Env, projectId: string) {
  const result = await env.DATABASE.prepare(
    `SELECT trigger_id,
    SUM(CASE WHEN status IN ('waiting','routing') THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='routed' THEN 1 ELSE 0 END) AS routed,
    SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) AS dropped
    FROM trigger_executions WHERE project_id=? GROUP BY trigger_id`
  )
    .bind(projectId)
    .all<{ trigger_id: string; queued: number; routed: number; dropped: number }>();
  return new Map(
    result.results.map((row) => [
      row.trigger_id,
      { queued: row.queued, routed: row.routed, dropped: row.dropped },
    ])
  );
}
