/**
 * GitHub Trigger Handler
 *
 * Routes incoming GitHub webhook events to matching triggers.
 * Called from the webhook endpoint after signature verification.
 *
 * Flow:
 * 1. Check GitHub trigger enablement
 * 2. Deduplicate by X-GitHub-Delivery ID
 * 3. Find the project linked to the webhook's repository
 * 4. Find active GitHub triggers for that project matching the event type
 * 5. Evaluate filters for each trigger
 * 6. For matching triggers, create execution records and submit tasks
 */
import type { GitHubTriggerFilters } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { buildGitHubContext } from './github-trigger-context';
import {
  evaluateFilters,
  type GitHubWebhookEvent,
  parseWebhookPayload,
} from './github-trigger-filter';
import { areGitHubTriggersConfigured } from './platform-config';
import { admitAndSubmitTriggerExecution } from './trigger-admission';
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
 * It's a best-effort operation — errors are logged but don't fail the webhook response.
 */
export async function handleGitHubEventForTriggers(
  env: Env,
  input: HandleGitHubEventInput
): Promise<HandleGitHubEventResult> {
  const { deliveryId, eventType, payload } = input;

  // GitHub App webhooks are considered enabled when the signing secret exists.
  // GITHUB_TRIGGERS_ENABLED remains an explicit kill switch for emergency disable.
  if (!(await areGitHubTriggersConfigured(env))) {
    return { processed: false, deliveryId, matchedTriggers: 0, reason: 'feature_disabled' };
  }

  // Only process event types we support for triggers
  const supportedEvents = ['issues', 'issue_comment', 'pull_request', 'push'];
  if (!supportedEvents.includes(eventType)) {
    return {
      processed: false,
      deliveryId,
      matchedTriggers: 0,
      reason: `unsupported_event_type:${eventType}`,
    };
  }

  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Atomic deduplication: INSERT OR IGNORE the delivery record immediately.
  // If the row already exists (duplicate delivery), the insert is silently ignored
  // and we detect it via the returned row count. This prevents race conditions
  // where concurrent Workers both pass a SELECT-based dedup check.
  try {
    const dedupResult = await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO github_webhook_deliveries (id, event_type, decision, decision_reason, created_at)
       VALUES (?, ?, 'processing', 'pending', ?)`
    )
      .bind(deliveryId, eventType, now)
      .run();

    if (!dedupResult.meta.changes || dedupResult.meta.changes === 0) {
      log.info('github_triggers.duplicate_delivery', { deliveryId, eventType });
      return { processed: false, deliveryId, matchedTriggers: 0, reason: 'duplicate' };
    }
  } catch (err) {
    log.warn('github_triggers.dedup_check_failed', {
      deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Parse event
  const event = parseWebhookPayload(eventType, payload);
  const repoFullName = event.repository?.full_name?.toLowerCase();
  const installationId =
    typeof payload.installation === 'object' && payload.installation !== null
      ? String((payload.installation as Record<string, unknown>).id ?? '')
      : undefined;

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
    .where(eq(schema.projects.repository, repoFullName));

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
      now
    );
    totalMatched += matched;
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
}

async function processTriggersForProject(
  env: Env,
  db: ReturnType<typeof drizzle>,
  project: { id: string; name: string },
  event: GitHubWebhookEvent,
  deliveryId: string,
  installationId: string | undefined,
  now: string
): Promise<number> {
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

    // Parse filters
    let filters: GitHubTriggerFilters;
    try {
      filters = JSON.parse(config.filtersJson) as GitHubTriggerFilters;
    } catch {
      log.error('github_triggers.invalid_filters_json', {
        triggerId: trigger.id,
        filtersJson: config.filtersJson,
      });
      continue;
    }

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

    const result = await admitAndSubmitTriggerExecution(env, {
      trigger,
      eventType: `github.${event.event}.${event.action ?? 'unknown'}`,
      triggeredBy: 'github',
      scheduledAt: now,
      renderPrompt: (executionId, sequenceNumber) =>
        renderTemplate(
          trigger.promptTemplate,
          buildGitHubContext(event, trigger, project, executionId, sequenceNumber)
        ).rendered,
    });

    if (result.outcome === 'submitted' || result.outcome === 'pending') {
      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: 'matched',
        decisionReason:
          result.outcome === 'pending' ? `task:${result.taskId}:pending` : `task:${result.taskId}`,
        createdAt: now,
      });

      log.info('github_triggers.matched', {
        triggerId: trigger.id,
        deliveryId,
        executionId: result.executionId,
        taskId: result.taskId,
        submissionPending: result.outcome === 'pending',
        eventType: event.event,
        action: event.action,
      });

      matched++;
    } else {
      const reason = result.outcome === 'failed' ? result.error : result.reason;
      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: result.outcome === 'failed' ? 'error' : 'skipped',
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
    await db.insert(schema.githubWebhookDeliveries).values(delivery);
  } catch (err) {
    // Best-effort — don't fail the webhook response for audit failures
    log.warn('github_triggers.delivery_record_failed', {
      deliveryId: delivery.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
