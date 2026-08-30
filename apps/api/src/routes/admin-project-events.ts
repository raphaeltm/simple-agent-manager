import type {
  AdminProjectEventInspectorAdapterDecision,
  AdminProjectEventInspectorResponse,
  AdminProjectEventInspectorTarget,
  ProjectEventDeliveryAdapterDecision,
  ProjectEventDeliveryPreference,
} from '@simple-agent-manager/shared';
import { DEFAULT_PROJECT_EVENT_LIMITS } from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import * as projectDataService from '../services/project-data';
import { listProjectEventSubscriptionsForCaller } from '../services/project-event-subscriptions';

const adminProjectEventRoutes = new Hono<{ Bindings: Env }>();

adminProjectEventRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

type ProjectRow = {
  id: string;
  name: string;
  repository: string | null;
  repo_provider: string | null;
  status: string | null;
  active_session_count: number | null;
  last_activity_at: string | null;
};

function normalizeInspectorLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PROJECT_EVENT_LIMITS.recentStatusLimit;
  }
  if (!/^\d+$/.test(value)) {
    throw errors.badRequest('limit must be a positive integer');
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw errors.badRequest('limit must be a positive integer');
  }
  return Math.min(parsed, DEFAULT_PROJECT_EVENT_LIMITS.listLimitMax);
}

function targetSummary(
  target: ProjectEventDeliveryPreference['target'] | null | undefined
): AdminProjectEventInspectorTarget {
  return {
    sessionId: target?.sessionId ?? null,
    taskId: target?.taskId ?? null,
    runtimeId: target?.runtimeId ?? null,
    agentId: target?.agentId ?? null,
  };
}

function adapterDecisionSummary(
  decision: ProjectEventDeliveryAdapterDecision
): AdminProjectEventInspectorAdapterDecision {
  return {
    action: decision.action,
    reason: decision.reason,
    adapterId: decision.adapterId,
    adapterKind: decision.adapterKind,
    capability: decision.capability,
    agentType: decision.agentType,
    protocol: decision.protocol,
    protocolVersion: decision.protocolVersion,
    durableAck: decision.durableAck,
    supported: decision.supported,
    authorized: decision.authorized,
    terminal: decision.terminal,
  };
}

async function readProject(env: Env, projectId: string): Promise<ProjectRow | null> {
  return (
    (await env.DATABASE.prepare(
      `SELECT id, name, repository, repo_provider, status, active_session_count, last_activity_at
       FROM projects
       WHERE id = ?
       LIMIT 1`
    )
      .bind(projectId)
      .first<ProjectRow>()) ?? null
  );
}

function buildInspectorResponse(input: {
  project: ProjectRow;
  limit: number;
  generatedAt: number;
  subscriptions: Awaited<
    ReturnType<typeof listProjectEventSubscriptionsForCaller>
  >['subscriptions'];
  status: Awaited<ReturnType<typeof projectDataService.getProjectEventRecentStatus>>;
}): AdminProjectEventInspectorResponse {
  const subscriptions = input.subscriptions.map((subscription) => ({
    id: subscription.id,
    owner: subscription.owner,
    state: subscription.state,
    reason: subscription.reason,
    filter: subscription.filter,
    matchKeyCount: subscription.matchKeyCount,
    requestedDelivery: subscription.deliveryPreference.requested,
    resolvedDelivery: subscription.deliveryPreference.resolved,
    target: targetSummary(subscription.deliveryPreference.target),
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    expiresAt: subscription.expiresAt,
    cancelledAt: subscription.cancelledAt,
    cancelledBy: subscription.cancelledBy,
    cancelReason: subscription.cancelReason,
    lastMatchedAt: subscription.lastMatchedAt,
  }));

  const events = input.status.events.map((event) => ({
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    subject: event.subject,
    severity: event.severity,
    state: event.state,
    display: {
      title: event.display.title,
      summary: event.display.summary,
      url: event.display.url,
      labels: event.display.labels,
      untrusted: true as const,
    },
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    updatedAt: event.updatedAt,
    duplicateCount: event.duplicateCount,
    conflictCount: event.conflictCount,
    hasRawPayloadRef: event.rawPayloadRef != null,
  }));

  const matches = input.status.matches.map((match) => ({
    id: match.id,
    eventId: match.eventId,
    subscriptionId: match.subscriptionId,
    state: match.state,
    matchedAt: match.matchedAt,
    lifecycleCheckedAt: match.lifecycleCheckedAt,
    batchId: match.batchId,
    reason: match.reason,
  }));

  const batches = input.status.batches.map((batch) => ({
    id: batch.id,
    subscriptionId: batch.subscriptionId,
    state: batch.state,
    requestedDelivery: batch.requestedDelivery,
    resolvedDelivery: batch.resolvedDelivery,
    target: targetSummary(batch.target),
    eventCount: batch.eventCount,
    matchCount: batch.matchIds.length,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    terminalAt: batch.terminalAt,
    terminalReason: batch.terminalReason,
    adapterDecision: adapterDecisionSummary(batch.adapterDecision),
  }));

  const attempts = input.status.attempts.map((attempt) => ({
    id: attempt.id,
    batchId: attempt.batchId,
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    adapter: attempt.adapter,
    protocolVersion: attempt.protocolVersion,
    runtimeId: attempt.runtimeId,
    receiptId: attempt.receiptId,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    createdAt: attempt.createdAt,
  }));

  const attentionBatchStates = new Set(['failed', 'ambiguous', 'expired']);
  const attentionAttemptStates = new Set(['retry', 'failed', 'ambiguous']);

  return {
    generatedAt: input.generatedAt,
    limit: input.limit,
    project: {
      id: input.project.id,
      name: input.project.name,
      repository: input.project.repository,
      repoProvider: input.project.repo_provider,
      status: input.project.status,
      activeSessionCount: input.project.active_session_count ?? 0,
      lastActivityAt: input.project.last_activity_at,
    },
    totals: {
      activeSubscriptions: subscriptions.filter((subscription) => subscription.state === 'active')
        .length,
      terminalSubscriptions: subscriptions.filter((subscription) => subscription.state !== 'active')
        .length,
      recentEvents: events.length,
      recentMatches: matches.length,
      recentBatches: batches.length,
      recentAttempts: attempts.length,
      attentionBatches: batches.filter((batch) => attentionBatchStates.has(batch.state)).length,
      attentionAttempts: attempts.filter((attempt) => attentionAttemptStates.has(attempt.state))
        .length,
    },
    subscriptions,
    events,
    matches,
    batches,
    attempts,
    accounting: input.status.accounting,
    hasMore: input.status.hasMore,
  };
}

/**
 * GET /api/admin/project-events/:projectId/inspector
 *
 * Superadmin-only read surface for ProjectData event-subscription status. The response
 * intentionally excludes event metadata and raw payload references; event display fields
 * remain marked `untrusted` for the browser.
 */
adminProjectEventRoutes.get('/:projectId/inspector', async (c) => {
  const projectId = c.req.param('projectId')?.trim();
  if (!projectId) throw errors.badRequest('projectId is required');

  const project = await readProject(c.env, projectId);
  if (!project) throw errors.notFound('Project');

  const limit = normalizeInspectorLimit(c.req.query('limit'));
  const actor = c.get('auth')?.user;
  const [subscriptionResult, status] = await Promise.all([
    listProjectEventSubscriptionsForCaller(
      c.env,
      {
        kind: 'platform',
        projectId,
        actorId: getUserId(c),
        actorName: actor?.name ?? actor?.email ?? null,
        permissions: { readAllSubscriptions: true },
      },
      { state: 'any', ownerScope: 'all', limit }
    ),
    projectDataService.getProjectEventRecentStatus(c.env, projectId, { limit }),
  ]);

  return c.json(
    buildInspectorResponse({
      project,
      limit,
      generatedAt: Date.now(),
      subscriptions: subscriptionResult.subscriptions,
      status,
    })
  );
});

export { adminProjectEventRoutes };
