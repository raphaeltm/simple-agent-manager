/** GitHub configuration replacement shared by REST and MCP updates. */
import type { GitHubTriggerEventType } from '@simple-agent-manager/shared';
import {
  DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
  DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import { eq, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { GitHubConfigValueSchema } from '../schemas/triggers';
import { resolveAdminSettingDetailsMany } from './admin-settings';
import { parseGitHubTriggerFiltersJson } from './github-trigger-filter';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export function parseGitHubTriggerConfig(input: unknown) {
  const parsed = v.safeParse(GitHubConfigValueSchema, input);
  if (!parsed.success) throw errors.badRequest(`Invalid githubConfig: ${parsed.issues[0].message}`);
  return { ...parsed.output, filters: parsed.output.filters ?? {} };
}

export async function getGitHubTriggerQueueLimits(env: Env) {
  const [pending, ttl] = await resolveAdminSettingDetailsMany(env, [
    'operations.githubTriggerQueueMaxPendingLimit',
    'operations.githubTriggerQueueTtlSecondsLimit',
  ]);
  if (!pending || !ttl) throw errors.internal('GitHub queue limits are unavailable');
  return { maxPending: Number(pending.value), ttlSeconds: Number(ttl.value) };
}

export async function validateGitHubTriggerQueueConfig(
  env: Env,
  input: unknown,
  options: { applyDefaults?: boolean } = {}
) {
  const config = parseGitHubTriggerConfig(input);
  const limits = await getGitHubTriggerQueueLimits(env);
  if (options.applyDefaults) {
    config.queueMaxPending ??= Math.min(
      DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
      limits.maxPending
    );
    config.queueTtlSeconds ??= Math.min(
      DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
      limits.ttlSeconds
    );
  }
  if (config.queueMaxPending !== undefined && config.queueMaxPending > limits.maxPending)
    throw errors.badRequest(`queueMaxPending must be between 1 and ${limits.maxPending}`);
  if (config.queueTtlSeconds !== undefined && config.queueTtlSeconds > limits.ttlSeconds)
    throw errors.badRequest(`queueTtlSeconds must be between 1 and ${limits.ttlSeconds}`);
  return config;
}

export function githubTriggerConfigUpdate(
  db: Database,
  triggerId: string,
  input: unknown,
  now: string
) {
  const config = parseGitHubTriggerConfig(input);
  return db
    .update(schema.githubTriggerConfigs)
    .set({
      eventType: config.eventType,
      filtersJson: JSON.stringify(config.filters),
      subjectAffinity: config.subjectAffinity ?? sql`subject_affinity`,
      queueMaxPending: config.queueMaxPending ?? sql`queue_max_pending`,
      queueTtlSeconds: config.queueTtlSeconds ?? sql`queue_ttl_seconds`,
      updatedAt: now,
    })
    .where(eq(schema.githubTriggerConfigs.triggerId, triggerId));
}

export async function readGitHubTriggerConfig(db: Database, triggerId: string) {
  const config = await db
    .select()
    .from(schema.githubTriggerConfigs)
    .where(eq(schema.githubTriggerConfigs.triggerId, triggerId))
    .get();
  if (!config) return undefined;
  const parsedFilters = parseGitHubTriggerFiltersJson(config.filtersJson);
  if (!parsedFilters.valid) log.warn('trigger.github_filters_invalid', { triggerId });
  return {
    eventType: config.eventType as GitHubTriggerEventType,
    filters: parsedFilters.filters,
    subjectAffinity: config.subjectAffinity ?? false,
    queueMaxPending: config.queueMaxPending ?? DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
    queueTtlSeconds: config.queueTtlSeconds ?? DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
  };
}

export async function assertGitHubTriggerConfigExists(db: Database, triggerId: string) {
  const config = await db
    .select({ id: schema.githubTriggerConfigs.id })
    .from(schema.githubTriggerConfigs)
    .where(eq(schema.githubTriggerConfigs.triggerId, triggerId))
    .get();
  if (!config) throw errors.notFound('GitHub trigger configuration');
}
