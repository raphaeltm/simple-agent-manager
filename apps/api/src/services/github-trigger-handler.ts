/**
 * GitHub Trigger Handler
 *
 * Routes incoming GitHub webhook events to matching triggers.
 * Called from the webhook endpoint after signature verification.
 *
 * Flow:
 * 1. Check GITHUB_TRIGGERS_ENABLED feature flag
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
import { ulid } from '../lib/ulid';
import {
  evaluateFilters,
  type GitHubWebhookEvent,
  parseWebhookPayload,
} from './github-trigger-filter';
import { submitTriggeredTask } from './trigger-submit';
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

  // Feature flag gate — must be explicitly set to "true" to enable
  if (env.GITHUB_TRIGGERS_ENABLED !== 'true') {
    return { processed: false, deliveryId, matchedTriggers: 0, reason: 'feature_disabled' };
  }

  // Only process event types we support for triggers
  const supportedEvents = ['issues', 'issue_comment', 'pull_request', 'push'];
  if (!supportedEvents.includes(eventType)) {
    return { processed: false, deliveryId, matchedTriggers: 0, reason: `unsupported_event_type:${eventType}` };
  }

  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  // Deduplicate by delivery ID
  const [existingDelivery] = await db
    .select({ id: schema.githubWebhookDeliveries.id })
    .from(schema.githubWebhookDeliveries)
    .where(eq(schema.githubWebhookDeliveries.id, deliveryId))
    .limit(1);

  if (existingDelivery) {
    log.info('github_triggers.duplicate_delivery', { deliveryId, eventType });
    return { processed: false, deliveryId, matchedTriggers: 0, reason: 'duplicate' };
  }

  // Parse event
  const event = parseWebhookPayload(eventType, payload);
  const repoFullName = event.repository?.full_name?.toLowerCase();
  const installationId = typeof payload.installation === 'object' && payload.installation !== null
    ? String((payload.installation as Record<string, unknown>).id ?? '')
    : undefined;

  if (!repoFullName) {
    await recordDelivery(db, {
      id: deliveryId,
      eventType,
      action: event.action,
      installationId,
      repositoryFullName: repoFullName,
      senderLogin: event.sender?.login,
      decision: 'no_match',
      decisionReason: 'no_repository_in_payload',
      createdAt: now,
    });
    return { processed: false, deliveryId, matchedTriggers: 0, reason: 'no_repository' };
  }

  // Find projects linked to this repository
  const projects = await db
    .select({ id: schema.projects.id, name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.repository, repoFullName));

  if (projects.length === 0) {
    await recordDelivery(db, {
      id: deliveryId,
      eventType,
      action: event.action,
      installationId,
      repositoryFullName: repoFullName,
      senderLogin: event.sender?.login,
      decision: 'no_match',
      decisionReason: 'no_project_for_repository',
      createdAt: now,
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
    await recordDelivery(db, {
      id: deliveryId,
      eventType,
      action: event.action,
      installationId,
      repositoryFullName: repoFullName,
      senderLogin: event.sender?.login,
      decision: 'no_match',
      decisionReason: 'no_triggers_matched',
      createdAt: now,
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
      log.error('github_triggers.invalid_filters_json', { triggerId: trigger.id, filtersJson: config.filtersJson });
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

    // Build template context and render prompt
    const executionId = ulid();
    const sequenceNumber = (trigger.triggerCount ?? 0) + 1;

    const context = buildGitHubContext(event, trigger, project, executionId, sequenceNumber);
    const rendered = renderTemplate(
      trigger.promptTemplate,
      context as unknown as Record<string, unknown>
    );

    // Create execution record
    await db.insert(schema.triggerExecutions).values({
      id: executionId,
      triggerId: trigger.id,
      projectId: project.id,
      status: 'queued',
      eventType: `github.${event.event}.${event.action ?? 'unknown'}`,
      renderedPrompt: rendered.rendered,
      scheduledAt: now,
      startedAt: now,
      sequenceNumber,
      createdAt: now,
    });

    // Submit the task
    try {
      const result = await submitTriggeredTask(env, {
        triggerId: trigger.id,
        triggerExecutionId: executionId,
        projectId: project.id,
        userId: trigger.userId,
        renderedPrompt: rendered.rendered,
        triggeredBy: 'github',
        agentProfileId: trigger.agentProfileId,
        taskMode: (trigger.taskMode ?? 'task') as 'task' | 'conversation',
        vmSizeOverride: trigger.vmSizeOverride,
        triggerName: trigger.name,
      });

      // Update execution with taskId
      await db
        .update(schema.triggerExecutions)
        .set({ taskId: result.taskId, status: 'running' })
        .where(eq(schema.triggerExecutions.id, executionId));

      // Update trigger metadata
      await db
        .update(schema.triggers)
        .set({
          lastTriggeredAt: now,
          triggerCount: sequenceNumber,
          updatedAt: now,
        })
        .where(eq(schema.triggers.id, trigger.id));

      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: 'matched',
        decisionReason: `task:${result.taskId}`,
        createdAt: now,
      });

      log.info('github_triggers.matched', {
        triggerId: trigger.id,
        deliveryId,
        executionId,
        taskId: result.taskId,
        eventType: event.event,
        action: event.action,
      });

      matched++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.triggerExecutions)
        .set({ status: 'failed', errorMessage: errorMsg, completedAt: new Date().toISOString() })
        .where(eq(schema.triggerExecutions.id, executionId));

      await recordDelivery(db, {
        id: `${deliveryId}:${trigger.id}`,
        eventType: event.event,
        action: event.action,
        installationId,
        repositoryFullName: event.repository?.full_name,
        senderLogin: event.sender?.login,
        matchedTriggerId: trigger.id,
        decision: 'error',
        decisionReason: errorMsg,
        createdAt: now,
      });

      log.error('github_triggers.submit_failed', {
        triggerId: trigger.id,
        deliveryId,
        executionId,
        error: errorMsg,
      });
    }
  }

  return matched;
}

/** Build the template context for a GitHub event. */
function buildGitHubContext(
  event: GitHubWebhookEvent,
  trigger: schema.TriggerRow,
  project: { id: string; name: string },
  executionId: string,
  sequenceNumber: number
): Record<string, unknown> {
  const labels = [
    ...(event.issue?.labels ?? []),
    ...(event.pull_request?.labels ?? []),
  ].map((l) => l.name);

  // Extract branch for push/PR events
  let branch = '';
  if (event.event === 'push' && event.ref) {
    branch = event.ref.replace(/^refs\/heads\//, '');
  } else if (event.pull_request?.head?.ref) {
    branch = event.pull_request.head.ref;
  }

  return {
    github: {
      event: event.event,
      action: event.action ?? '',
      actor: event.sender?.login ?? '',
      repository: event.repository?.full_name ?? '',
      number: String(event.issue?.number ?? event.pull_request?.number ?? ''),
      title: event.issue?.title ?? event.pull_request?.title ?? '',
      body: event.issue?.body ?? event.pull_request?.body ?? '',
      comment: event.comment?.body ?? '',
      labels: labels.join(', '),
      branch,
      sha: event.head_commit?.id ?? '',
    },
    trigger: {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description ?? '',
      fireCount: String((trigger.triggerCount ?? 0) + 1),
    },
    project: {
      id: project.id,
      name: project.name,
    },
    execution: {
      id: executionId,
      sequenceNumber: String(sequenceNumber),
    },
  };
}

/** Record a webhook delivery for dedup and audit. */
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
