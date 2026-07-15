/** Authenticated trigger CRUD. Execution actions live in actions.ts. */
import type {
  CreateTriggerResponse,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
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
import { parsePositiveInt, requireRouteParam } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { getAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { CreateTriggerSchema, jsonValidator, UpdateTriggerSchema } from '../../schemas';
import { buildCredentialAttributionForTriggers } from '../../services/credential-attribution-health';
import {
  cronToHumanReadable,
  cronToNextFire,
  validateCronExpression,
} from '../../services/cron-utils';
import { getProjectMultiplayerState } from '../../services/project-multiplayer';
import {
  getWebhookTriggerLimits,
  validateWebhookTriggerConfig,
} from '../../services/webhook-trigger-config';
import {
  createWebhookTokenMaterial,
  mergeWebhookConfig,
  toWebhookTriggerConfig,
  webhookConfigUpdateValues,
  webhookConfigValues,
} from '../../services/webhook-trigger-store';
import { requireProjectTaskRead, requireProjectTaskWrite } from '../task-project-auth';
import { buildWebhookCredential } from './webhooks';

const crudRoutes = new Hono<{ Bindings: Env }>();
type Database = ReturnType<typeof drizzle<typeof schema>>;

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
    skipIfRunning: row.skipIfRunning,
    promptTemplate: row.promptTemplate,
    agentProfileId: row.agentProfileId,
    skillId: row.skillId,
    taskMode: (row.taskMode ?? 'task') as TriggerResponse['taskMode'],
    vmSizeOverride: row.vmSizeOverride,
    maxConcurrent: row.maxConcurrent,
    lastTriggeredAt: row.lastTriggeredAt,
    triggerCount: row.triggerCount,
    nextFireAt: row.nextFireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cronHumanReadable: row.cronExpression
      ? cronToHumanReadable(row.cronExpression, row.cronTimezone ?? 'UTC')
      : undefined,
  };
}

async function attribution(
  db: Database,
  env: Env,
  project: schema.Project,
  triggers: schema.TriggerRow[]
) {
  const [multiplayer, checks] = await Promise.all([
    getProjectMultiplayerState(db, project.id),
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

async function enrichTrigger(
  db: Database,
  row: schema.TriggerRow,
  credentialAttribution?: TriggerResponse['credentialAttribution']
): Promise<TriggerResponse> {
  const response = toTriggerResponse(row);
  response.credentialAttribution = credentialAttribution;
  if (row.sourceType === 'github') {
    const config = await db
      .select()
      .from(schema.githubTriggerConfigs)
      .where(eq(schema.githubTriggerConfigs.triggerId, row.id))
      .get();
    if (config) {
      response.githubConfig = {
        eventType: config.eventType as GitHubTriggerEventType,
        filters: JSON.parse(config.filtersJson) as GitHubTriggerFilters,
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
  return response;
}

async function validateReferences(
  db: Database,
  projectId: string,
  agentProfileId: string | null | undefined,
  skillId: string | null | undefined
) {
  if (agentProfileId) {
    const profile = await db
      .select({ id: schema.agentProfiles.id })
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.id, agentProfileId),
          eq(schema.agentProfiles.projectId, projectId)
        )
      )
      .get();
    if (!profile) throw errors.notFound('Agent profile');
  }
  if (skillId) {
    const skill = await db
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(and(eq(schema.skills.id, skillId), eq(schema.skills.projectId, projectId)))
      .get();
    if (!skill) throw errors.notFound('Skill');
  }
}

function validateCron(env: Env, expression: string | undefined, timezone: string | undefined) {
  if (!expression) throw errors.badRequest('cronExpression is required for cron triggers');
  const validation = validateCronExpression(
    expression,
    parsePositiveInt(env.CRON_MIN_INTERVAL_MINUTES, DEFAULT_CRON_MIN_INTERVAL_MINUTES)
  );
  if (!validation.valid) throw errors.badRequest(`Invalid cron expression: ${validation.error}`);
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone ?? 'UTC' });
  } catch {
    throw errors.badRequest(`Invalid timezone: ${timezone}`);
  }
}

crudRoutes.post('/', jsonValidator(CreateTriggerSchema), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const userId = getAuth(c).user.id;
  const project = await requireProjectTaskWrite(db, projectId, userId);
  const body = c.req.valid('json');
  const name = body.name.trim();
  const promptTemplate = body.promptTemplate.trim();
  if (!name) throw errors.badRequest('name is required');
  if (!promptTemplate) throw errors.badRequest('promptTemplate is required');
  if (
    promptTemplate.length >
    parsePositiveInt(c.env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH)
  ) {
    throw errors.badRequest('promptTemplate is too long');
  }
  if (body.sourceType === 'cron') validateCron(c.env, body.cronExpression, body.cronTimezone);
  if (body.sourceType === 'github' && !body.githubConfig?.eventType) {
    throw errors.badRequest('githubConfig.eventType is required for github triggers');
  }
  if (body.sourceType === 'webhook' && (!body.webhookConfig || !body.agentProfileId)) {
    throw errors.badRequest('webhookConfig and agentProfileId are required for webhook triggers');
  }
  if (body.webhookConfig) {
    const configError = validateWebhookTriggerConfig(
      body.webhookConfig,
      getWebhookTriggerLimits(c.env)
    );
    if (configError) throw errors.badRequest(configError);
  }
  await validateReferences(db, projectId, body.agentProfileId, body.skillId);

  const [sameName, total] = await Promise.all([
    db
      .select({ id: schema.triggers.id })
      .from(schema.triggers)
      .where(and(eq(schema.triggers.projectId, projectId), eq(schema.triggers.name, name)))
      .get(),
    db
      .select({ count: count() })
      .from(schema.triggers)
      .where(eq(schema.triggers.projectId, projectId))
      .get(),
  ]);
  if (sameName) throw errors.conflict(`Trigger "${name}" already exists in this project`);
  if (
    (total?.count ?? 0) >=
    parsePositiveInt(c.env.MAX_TRIGGERS_PER_PROJECT, DEFAULT_MAX_TRIGGERS_PER_PROJECT)
  ) {
    throw errors.badRequest('Maximum triggers per project reached');
  }
  const maxConcurrent = body.maxConcurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT;
  const maxConcurrentLimit = parsePositiveInt(
    c.env.TRIGGER_MAX_CONCURRENT_LIMIT,
    DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT
  );
  if (maxConcurrent < 1 || maxConcurrent > maxConcurrentLimit) {
    throw errors.badRequest(`maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
  }

  const id = ulid();
  const now = new Date().toISOString();
  const values: schema.NewTriggerRow = {
    id,
    projectId,
    userId,
    name,
    description: body.description?.trim() || null,
    status: 'active',
    sourceType: body.sourceType,
    cronExpression: body.sourceType === 'cron' ? body.cronExpression! : null,
    cronTimezone: body.sourceType === 'cron' ? (body.cronTimezone ?? 'UTC') : null,
    skipIfRunning: body.skipIfRunning ?? true,
    promptTemplate,
    agentProfileId: body.agentProfileId ?? null,
    skillId: body.skillId ?? null,
    taskMode: body.taskMode ?? 'task',
    vmSizeOverride: body.vmSizeOverride ?? null,
    maxConcurrent,
    nextFireAt:
      body.sourceType === 'cron'
        ? cronToNextFire(body.cronExpression!, body.cronTimezone ?? 'UTC')
        : null,
    createdAt: now,
    updatedAt: now,
  };

  let webhookToken: Awaited<ReturnType<typeof createWebhookTokenMaterial>> | undefined;
  if (body.sourceType === 'webhook' && body.webhookConfig) {
    webhookToken = await createWebhookTokenMaterial(c.env.ENCRYPTION_KEY);
    await db.batch([
      db.insert(schema.triggers).values(values),
      db
        .insert(schema.webhookTriggerConfigs)
        .values(webhookConfigValues(id, body.webhookConfig, webhookToken)),
    ]);
  } else {
    await db.insert(schema.triggers).values(values);
    if (body.sourceType === 'github' && body.githubConfig) {
      await db.insert(schema.githubTriggerConfigs).values({
        id: ulid(),
        triggerId: id,
        eventType: body.githubConfig.eventType,
        filtersJson: JSON.stringify(body.githubConfig.filters ?? {}),
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  const created = await db.select().from(schema.triggers).where(eq(schema.triggers.id, id)).get();
  if (!created) throw errors.internal('Created trigger not found');
  const attributionById = await attribution(db, c.env, project, [created]);
  const response: CreateTriggerResponse = {
    ...(await enrichTrigger(db, created, attributionById.get(id))),
    webhookCredential: webhookToken
      ? buildWebhookCredential(c.env, webhookToken.token)
      : undefined,
  };
  log.info('trigger.created', { triggerId: id, projectId, sourceType: body.sourceType });
  if (webhookToken) c.header('Cache-Control', 'private, no-store');
  return c.json(response, 201);
});

crudRoutes.get('/', async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireProjectTaskRead(db, projectId, getAuth(c).user.id);
  const rows = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.projectId, projectId))
    .orderBy(desc(schema.triggers.createdAt));
  const ids = rows.map((row) => row.id);
  const [githubConfigs, webhookConfigs, attributionById] = await Promise.all([
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
    attribution(db, c.env, project, rows),
  ]);
  const githubById = new Map(githubConfigs.map((config) => [config.triggerId, config]));
  const webhookById = new Map(webhookConfigs.map((config) => [config.triggerId, config]));
  const triggers = rows.map((row) => {
    const response = toTriggerResponse(row);
    response.credentialAttribution = attributionById.get(row.id);
    const github = githubById.get(row.id);
    if (github) {
      response.githubConfig = {
        eventType: github.eventType as GitHubTriggerEventType,
        filters: JSON.parse(github.filtersJson) as GitHubTriggerFilters,
      };
    }
    const webhook = webhookById.get(row.id);
    if (webhook) response.webhookConfig = toWebhookTriggerConfig(webhook);
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
    ...(await enrichTrigger(db, trigger, attributionById.get(triggerId))),
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
  if (body.webhookConfig && trigger.sourceType !== 'webhook') {
    throw errors.badRequest('webhookConfig is only valid for webhook triggers');
  }
  if (trigger.sourceType === 'webhook' && body.agentProfileId === null) {
    throw errors.badRequest('agentProfileId is required for webhook triggers');
  }
  await validateReferences(db, projectId, body.agentProfileId, body.skillId);
  const now = new Date().toISOString();
  const updates: Partial<schema.NewTriggerRow> = { updatedAt: now };
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
    updates.cronExpression = expression;
    updates.cronTimezone = timezone;
    if ((body.status ?? trigger.status) === 'active') {
      updates.nextFireAt = cronToNextFire(expression!, timezone);
    }
  }
  if (body.status !== undefined) {
    updates.status = body.status;
    if (body.status !== 'active') updates.nextFireAt = null;
    if (body.status === 'active' && trigger.sourceType === 'cron' && trigger.cronExpression) {
      updates.nextFireAt = cronToNextFire(trigger.cronExpression, trigger.cronTimezone ?? 'UTC');
    }
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
  const triggerUpdate = db
    .update(schema.triggers)
    .set(updates)
    .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)));
  if (effectiveWebhookConfig) {
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
  const attributionById = await attribution(db, c.env, project, [updated]);
  log.info('trigger.updated', { triggerId, projectId, fields: Object.keys(body) });
  return c.json(await enrichTrigger(db, updated, attributionById.get(triggerId)));
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
  log.info('trigger.deleted', { triggerId, projectId });
  return c.json({ success: true });
});

export { crudRoutes };
