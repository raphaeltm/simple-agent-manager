/** Canonical trigger creation shared by authenticated REST and project-scoped MCP. */
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';
import { and, count, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import type { CreateTriggerSchema } from '../schemas/triggers';
import { cronToNextFire, validateCronExpression } from './cron-utils';
import type { McpTokenData } from './mcp-token';
import {
  ResourceRequirementsValidationError,
  serializeResourceRequirementsInput,
} from './resource-requirements-input';
import { clearTriggerPageCaches } from './trigger-cache';
import { resolveMaxTriggersPerProject } from './trigger-limits';
import { prepareWebhookClaim } from './webhook-credential-claim';
import { getWebhookTriggerLimits, validateWebhookTriggerConfig } from './webhook-trigger-config';
import { createWebhookTokenMaterial, webhookConfigValues } from './webhook-trigger-store';
type Database = ReturnType<typeof drizzle<typeof schema>>;
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

export async function validateReferences(
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

export function validateCron(
  env: Env,
  expression: string | undefined,
  timezone: string | undefined
) {
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

export function validateTriggerSourceFields(
  sourceType: string,
  body: {
    githubConfig?: unknown;
    cronExpression?: unknown;
    cronTimezone?: unknown;
    webhookConfig?: unknown;
  }
) {
  if (body.githubConfig !== undefined && sourceType !== 'github')
    throw errors.badRequest('githubConfig is only valid for github triggers');
  if (
    (body.cronExpression !== undefined || body.cronTimezone !== undefined) &&
    sourceType !== 'cron'
  )
    throw errors.badRequest('Cron schedule fields are only valid for cron triggers');
  if (body.webhookConfig !== undefined && sourceType !== 'webhook')
    throw errors.badRequest('webhookConfig is only valid for webhook triggers');
}

function validateTriggerCreation(env: Env, body: v.InferOutput<typeof CreateTriggerSchema>) {
  const name = body.name.trim();
  const promptTemplate = body.promptTemplate.trim();
  if (!name) throw errors.badRequest('name is required');
  if (
    name.length > parsePositiveInt(env.TRIGGER_NAME_MAX_LENGTH, DEFAULT_TRIGGER_NAME_MAX_LENGTH)
  ) {
    throw errors.badRequest('name is too long');
  }
  if (!promptTemplate) throw errors.badRequest('promptTemplate is required');
  if (
    promptTemplate.length >
    parsePositiveInt(env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH)
  ) {
    throw errors.badRequest('promptTemplate is too long');
  }
  validateTriggerSourceFields(body.sourceType, body);
  if (body.sourceType === 'cron') validateCron(env, body.cronExpression, body.cronTimezone);
  if (body.sourceType === 'github' && !body.githubConfig?.eventType) {
    throw errors.badRequest('githubConfig.eventType is required for github triggers');
  }
  if (body.sourceType === 'webhook' && (!body.webhookConfig || !body.agentProfileId)) {
    throw errors.badRequest('webhookConfig and agentProfileId are required for webhook triggers');
  }
  if (body.webhookConfig) {
    const configError = validateWebhookTriggerConfig(
      body.webhookConfig,
      getWebhookTriggerLimits(env)
    );
    if (configError) throw errors.badRequest(configError);
  }
  return { name, promptTemplate };
}

export async function createTrigger(
  db: Database,
  env: Env,
  project: Pick<schema.Project, 'id' | 'maxTriggers'>,
  userId: string,
  body: v.InferOutput<typeof CreateTriggerSchema>,
  claimIdentity?: McpTokenData
) {
  const projectId = project.id;
  const { name, promptTemplate } = validateTriggerCreation(env, body);
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
  const maxTriggers = resolveMaxTriggersPerProject(
    project.maxTriggers,
    env.MAX_TRIGGERS_PER_PROJECT
  );
  if ((total?.count ?? 0) >= maxTriggers) {
    throw errors.badRequest(`Maximum triggers per project (${maxTriggers}) reached`);
  }
  const maxConcurrent = body.maxConcurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT;
  const maxConcurrentLimit = parsePositiveInt(
    env.TRIGGER_MAX_CONCURRENT_LIMIT,
    DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT
  );
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxConcurrentLimit) {
    throw errors.badRequest(`maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
  }

  // validateCron() above already throws when cronExpression is falsy for a
  // 'cron' trigger, but that guarantee doesn't propagate back onto
  // body.cronExpression's type here — re-check explicitly instead of
  // asserting.
  let cronExpression: string | null = null;
  let cronTimezone: string | null = null;
  let nextFireAt: string | null = null;
  if (body.sourceType === 'cron') {
    if (!body.cronExpression) {
      throw errors.badRequest('cronExpression is required for cron triggers');
    }
    cronExpression = body.cronExpression;
    cronTimezone = body.cronTimezone ?? 'UTC';
    nextFireAt = cronToNextFire(cronExpression, cronTimezone);
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
    cronExpression,
    cronTimezone,
    skipIfRunning: body.skipIfRunning ?? true,
    promptTemplate,
    agentProfileId: body.agentProfileId ?? null,
    skillId: body.skillId ?? null,
    taskMode: body.taskMode ?? 'task',
    vmSizeOverride: body.vmSizeOverride ?? null,
    resourceRequirementsJson: triggerResourceRequirementsJson(body),
    maxConcurrent,
    nextFireAt,
    createdAt: now,
    updatedAt: now,
  };

  const claim =
    body.sourceType === 'webhook' && claimIdentity
      ? prepareWebhookClaim(env, claimIdentity)
      : undefined;
  let webhookToken: Awaited<ReturnType<typeof createWebhookTokenMaterial>> | undefined;
  if (body.sourceType === 'webhook' && body.webhookConfig) {
    webhookToken = await createWebhookTokenMaterial(env.ENCRYPTION_KEY);
    await db.batch([
      db.insert(schema.triggers).values(values),
      db
        .insert(schema.webhookTriggerConfigs)
        .values({ ...webhookConfigValues(id, body.webhookConfig, webhookToken), ...claim?.values }),
    ]);
  } else if (body.sourceType === 'github' && body.githubConfig) {
    await db.batch([
      db.insert(schema.triggers).values(values),
      db.insert(schema.githubTriggerConfigs).values({
        id: ulid(),
        triggerId: id,
        eventType: body.githubConfig.eventType,
        filtersJson: JSON.stringify(body.githubConfig.filters ?? {}),
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } else {
    await db.insert(schema.triggers).values(values);
  }

  const created = await db.select().from(schema.triggers).where(eq(schema.triggers.id, id)).get();
  if (!created) throw errors.internal('Created trigger not found');
  clearTriggerPageCaches(projectId);
  return { created, webhookToken: claim ? undefined : webhookToken, webhookClaim: claim?.response };
}
