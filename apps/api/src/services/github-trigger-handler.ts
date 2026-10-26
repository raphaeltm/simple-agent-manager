import {
  DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
  DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
  GITHUB_TRIGGER_EVENT_TYPES,
} from '@simple-agent-manager/shared';
/**
 * GitHub Trigger Handler
 *
 * Routes incoming GitHub webhook events to matching triggers.
 * Called from the webhook endpoint after signature verification.
 *
 * Flow:
 * 1. Check GitHub trigger enablement
 * 2. Reuse a reserved execution per delivery/trigger (intake owns delivery dedup)
 * 3. Find the project linked to the webhook's repository
 * 4. Find active GitHub triggers for that project matching the event type
 * 5. Evaluate filters for each trigger
 * 6. For matching triggers, create execution records and submit tasks
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { buildGitHubContext } from './github-trigger-context';
import {
  evaluateFilters,
  type GitHubWebhookEvent,
  parseGitHubTriggerFiltersJson,
  parseWebhookPayload,
} from './github-trigger-filter';
import {
  acceptGitHubTriggerExecution,
  githubSubjectKey,
  syncGitHubExecutionAudit,
} from './github-trigger-queue';
import { areGitHubTriggersConfigured } from './platform-config';
import { renderTemplate } from './trigger-template';

export interface HandleGitHubEventInput {
  deliveryId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface HandleGitHubEventResult {
  processed: boolean;
  deliveryId: string;
  matchedTriggers: number;
  reason?: string;
}

/**
 * Handle a verified GitHub webhook event for trigger matching.
 *
 * This is called after webhook signature verification succeeds.
 * Intake/lease ownership and retry live in github-trigger-recovery.ts.
 * Errors propagate so its durable attempt remains retryable.
 */
export async function handleGitHubEventForTriggers(
  env: Env,
  input: HandleGitHubEventInput,
  recovery: {
    scheduledAt?: string;
    processingToken?: string;
    beforeSubmit?: (executionId: string) => Promise<void>;
  } = {}
): Promise<HandleGitHubEventResult> {
  const { deliveryId, eventType, payload } = input;

  // GitHub App webhooks are considered enabled when the signing secret exists.
  // GITHUB_TRIGGERS_ENABLED remains an explicit kill switch for emergency disable.
  if (!(await areGitHubTriggersConfigured(env))) {
    return { processed: false, deliveryId, matchedTriggers: 0, reason: 'feature_disabled' };
  }

  // Only process event types we support for triggers
  const supportedEvents: readonly string[] = GITHUB_TRIGGER_EVENT_TYPES;
  if (!supportedEvents.includes(eventType)) {
    return {
      processed: false,
      deliveryId,
      matchedTriggers: 0,
      reason: `unsupported_event_type:${eventType}`,
    };
  }

  const db = drizzle(env.DATABASE, { schema });
  const now = recovery.scheduledAt ?? new Date().toISOString();

  try {
    // Parse event
    const event = parseWebhookPayload(eventType, payload);
    const repoFullName = event.repository?.full_name?.toLowerCase();
    const installation = payload.installation as Record<string, unknown> | null;
    const externalId =
      installation && typeof installation === 'object' ? installation.id : undefined;
    const installationId =
      typeof externalId === 'number' && Number.isSafeInteger(externalId) && externalId > 0
        ? String(externalId)
        : undefined;
    const repository = payload.repository as Record<string, unknown> | null;
    const repositoryId = repository && typeof repository === 'object' ? repository.id : undefined;
    if (
      !installationId ||
      typeof repositoryId !== 'number' ||
      !Number.isSafeInteger(repositoryId) ||
      repositoryId <= 0
    ) {
      await updateDeliveryDecision(db, deliveryId, {
        decision: 'no_match',
        decisionReason: 'invalid_installation_or_repository_id',
      });
      return { processed: false, deliveryId, matchedTriggers: 0, reason: 'invalid_scope' };
    }

    if (!repoFullName) {
      await updateDeliveryDecision(db, deliveryId, {
        action: event.action,
        installationId,
        senderLogin: event.sender?.login,
        decision: 'no_match',
        decisionReason: 'no_repository_in_payload',
      });
      return { processed: false, deliveryId, matchedTriggers: 0, reason: 'no_repository' };
    }

    // Find projects linked to this repository
    const projects = await db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .innerJoin(
        schema.githubInstallations,
        eq(schema.projects.installationId, schema.githubInstallations.id)
      )
      .where(
        and(
          eq(schema.projects.status, 'active'),
          eq(schema.projects.repoProvider, 'github'),
          eq(
            sql`COALESCE(NULLIF(${schema.githubInstallations.externalInstallationId}, ''), ${schema.githubInstallations.installationId})`,
            installationId
          ),
          or(
            eq(schema.projects.githubRepoId, repositoryId),
            and(
              isNull(schema.projects.githubRepoId),
              eq(sql`LOWER(${schema.projects.repository})`, repoFullName)
            )
          )
        )
      );

    if (projects.length === 0) {
      await updateDeliveryDecision(db, deliveryId, {
        action: event.action,
        installationId,
        repositoryFullName: repoFullName,
        senderLogin: event.sender?.login,
        decision: 'no_match',
        decisionReason: 'no_project_for_repository',
      });
      return { processed: false, deliveryId, matchedTriggers: 0, reason: 'no_project' };
    }

    let totalMatched = 0;

    for (const project of projects) {
      const matched = await processTriggersForProject(
        env,
        db,
        project,
        event,
        deliveryId,
        installationId,
        repositoryId,
        {
          scheduledAt: now,
          beforeSubmit: recovery.beforeSubmit,
          processingToken: recovery.processingToken,
        }
      );
      totalMatched += matched;
    }

    if (totalMatched > 0) {
      await updateDeliveryDecision(db, deliveryId, {
        action: event.action,
        installationId,
        repositoryFullName: repoFullName,
        senderLogin: event.sender?.login,
        decision: 'matched',
        decisionReason: `matched_triggers:${totalMatched}`,
      });
    }
    if (totalMatched === 0) {
      await updateDeliveryDecision(db, deliveryId, {
        action: event.action,
        installationId,
        repositoryFullName: repoFullName,
        senderLogin: event.sender?.login,
        decision: 'no_match',
        decisionReason: 'no_triggers_matched',
      });
    }

    return { processed: totalMatched > 0, deliveryId, matchedTriggers: totalMatched };
  } catch (error) {
    await updateDeliveryDecision(db, deliveryId, {
      decision: 'error',
      decisionReason: 'trigger_routing_failed',
    });
    throw error;
  }
}

async function processTriggersForProject(
  env: Env,
  db: ReturnType<typeof drizzle>,
  project: { id: string; name: string },
  event: GitHubWebhookEvent,
  deliveryId: string,
  installationId: string | undefined,
  repositoryId: number,
  recovery: {
    scheduledAt: string;
    beforeSubmit?: (executionId: string) => Promise<void>;
    processingToken?: string;
  }
): Promise<number> {
  const { scheduledAt: now, beforeSubmit, processingToken } = recovery;
  // Find active GitHub triggers for this project
  const triggers = await db
    .select()
    .from(schema.triggers)
    .where(
      and(
        eq(schema.triggers.projectId, project.id),
        eq(schema.triggers.sourceType, 'github'),
        eq(schema.triggers.status, 'active')
      )
    );

  if (triggers.length === 0) return 0;

  // Get GitHub configs for these triggers in a single query
  const triggerIds = triggers.map((t) => t.id);
  const configs = await db
    .select()
    .from(schema.githubTriggerConfigs)
    .where(inArray(schema.githubTriggerConfigs.triggerId, triggerIds));

  const configByTriggerId = new Map(configs.map((c) => [c.triggerId, c]));

  let matched = 0;

  for (const trigger of triggers) {
    const config = configByTriggerId.get(trigger.id);
    if (!config) {
      log.warn('github_triggers.missing_config', { triggerId: trigger.id, projectId: project.id });
      continue;
    }

    // Check event type matches
    if (config.eventType !== event.event) continue;

    // Parse filters. Untrusted (unparseable or wrong-shape) filters are treated
    // as "cannot evaluate this trigger safely" rather than falling back to an
    // empty "match everything" filter set — corrupted filter data must not
    // cause a trigger to auto-fire that a valid config would have filtered out.
    const parsedFilters = parseGitHubTriggerFiltersJson(config.filtersJson);
    if (!parsedFilters.valid) {
      log.error('github_triggers.invalid_filters_json', {
        triggerId: trigger.id,
        filtersJson: config.filtersJson,
      });
      continue;
    }
    const filters = parsedFilters.filters;

    // Evaluate filters
    const filterResult = evaluateFilters(event, filters);

    if (!filterResult.matched) {
      log.info('github_triggers.filtered', {
        triggerId: trigger.id,
        deliveryId,
        eventType: event.event,
        reason: filterResult.reason,
      });
      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: 'filtered',
        decisionReason: filterResult.reason,
        createdAt: now,
      });
      continue;
    }

    const result = await acceptGitHubTriggerExecution(env, {
      trigger,
      githubDeliveryId: deliveryId,
      subjectKey: githubSubjectKey(repositoryId, event.issue?.number ?? event.pull_request?.number),
      subjectAffinity: config.subjectAffinity,
      queueMaxPending: config.queueMaxPending ?? DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING,
      queueTtlSeconds: config.queueTtlSeconds ?? DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS,
      beforeSubmit,
      githubProcessingToken: processingToken,
      eventType: `github.${event.event}.${event.action ?? 'unknown'}`,
      triggeredBy: 'github',
      scheduledAt: now,
      renderPrompt: (executionId, sequenceNumber, reservedTrigger = trigger) =>
        renderTemplate(
          reservedTrigger.promptTemplate,
          buildGitHubContext(event, reservedTrigger, project, executionId, sequenceNumber)
        ).rendered,
    });

    if (result.outcome === 'pending') throw new Error('GitHub trigger startup requires recovery');
    if (result.outcome === 'failed') throw new Error('GitHub trigger submission requires recovery');

    if (
      ['submitted', 'waiting', 'routing', 'routed', 'dropped', 'running', 'completed'].includes(
        result.outcome
      )
    ) {
      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision:
          result.outcome === 'waiting'
            ? 'queued'
            : result.outcome === 'submitted'
              ? 'matched'
              : result.outcome,
        decisionReason: result.taskId
          ? `task:${result.taskId};session:${result.sessionId ?? ''}`
          : (result.reason ?? `execution:${result.executionId}`),
        createdAt: now,
      });

      log.info('github_triggers.matched', {
        triggerId: trigger.id,
        deliveryId,
        executionId: result.executionId,
        taskId: result.taskId,
        submissionPending: false,
        eventType: event.event,
        action: event.action,
      });

      await syncGitHubExecutionAudit(env, result.executionId);
      matched++;
    } else {
      const reason = result.reason;
      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: 'skipped',
        decisionReason: reason,
        createdAt: now,
      });

      log.info('github_triggers.not_submitted', {
        triggerId: trigger.id,
        deliveryId,
        outcome: result.outcome,
        reason,
      });
    }
  }

  return matched;
}

/** Update the initial delivery record with final decision details. */
async function updateDeliveryDecision(
  db: ReturnType<typeof drizzle>,
  deliveryId: string,
  updates: {
    action?: string;
    installationId?: string;
    repositoryFullName?: string;
    senderLogin?: string;
    matchedTriggerId?: string;
    decision: string;
    decisionReason?: string;
  }
): Promise<void> {
  try {
    await db
      .update(schema.githubWebhookDeliveries)
      .set({
        action: updates.action,
        installationId: updates.installationId,
        repositoryFullName: updates.repositoryFullName,
        senderLogin: updates.senderLogin,
        matchedTriggerId: updates.matchedTriggerId,
        decision: updates.decision,
        decisionReason: updates.decisionReason,
      })
      .where(eq(schema.githubWebhookDeliveries.id, deliveryId));
  } catch (err) {
    log.warn('github_triggers.delivery_update_failed', {
      deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Record a per-trigger webhook delivery for audit (composite ID). */
async function recordDelivery(
  db: ReturnType<typeof drizzle>,
  delivery: schema.NewGitHubWebhookDeliveryRow
): Promise<void> {
  try {
    await db.insert(schema.githubWebhookDeliveries).values(delivery).onConflictDoNothing();
  } catch (err) {
    // Best-effort — don't fail the webhook response for audit failures
    log.warn('github_triggers.delivery_record_failed', {
      deliveryId: delivery.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
