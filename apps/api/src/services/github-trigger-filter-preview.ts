/** Read-only draft-filter evaluation. Never replays a delivery or returns external text. */
import type { GitHubFilterPreviewResponse } from '@simple-agent-manager/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { requireProjectTaskRead } from '../routes/task-project-auth';
import { parseGitHubTriggerConfig } from './github-trigger-config';
import { evaluateFilters, parseWebhookPayload } from './github-trigger-filter';
import { githubTriggerRecoveryConfig } from './github-trigger-recovery-config';

export async function previewRecentGitHubFilters(
  env: Env,
  projectId: string,
  userId: string,
  input: unknown
): Promise<GitHubFilterPreviewResponse> {
  const db = drizzle(env.DATABASE, { schema });
  await requireProjectTaskRead(db, projectId, userId);
  const config = parseGitHubTriggerConfig(input);
  const project = await db
    .select({
      repository: schema.projects.repository,
      installationId: sql<string>`COALESCE(NULLIF(${schema.githubInstallations.externalInstallationId}, ''), ${schema.githubInstallations.installationId})`,
    })
    .from(schema.projects)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.projects.installationId, schema.githubInstallations.id)
    )
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw errors.notFound('GitHub project installation');
  const retention = githubTriggerRecoveryConfig(env);
  const limit = retention.batchSize;
  const rows = await db
    .select({
      id: schema.githubWebhookDeliveries.id,
      eventType: schema.githubWebhookDeliveries.eventType,
      action: schema.githubWebhookDeliveries.action,
      receivedAt: schema.githubWebhookDeliveries.createdAt,
      payload: schema.githubTriggerInbox.payloadJson,
      expiresAt: schema.githubTriggerInbox.expiresAt,
      payloadCreatedAt: schema.githubTriggerInbox.createdAt,
    })
    .from(schema.githubWebhookDeliveries)
    .leftJoin(
      schema.githubTriggerInbox,
      eq(schema.githubWebhookDeliveries.id, schema.githubTriggerInbox.id)
    )
    .where(
      and(
        eq(
          sql`LOWER(${schema.githubWebhookDeliveries.repositoryFullName})`,
          project.repository.toLowerCase()
        ),
        eq(schema.githubWebhookDeliveries.installationId, project.installationId),
        eq(schema.githubWebhookDeliveries.eventType, config.eventType)
      )
    )
    .orderBy(desc(schema.githubWebhookDeliveries.createdAt))
    .limit(limit);
  const now = new Date().toISOString();
  return {
    limit,
    warning:
      'Audit rows do not retain payloads. Only unexpired recovery payloads can be evaluated; unavailable deliveries are not matches. This checks filters only, not admission, queueing or routing.',
    deliveries: rows.map((row) => {
      const evidence = {
        id: row.id,
        eventType: row.eventType,
        action: row.action,
        receivedAt: row.receivedAt,
      };
      const payloadCreatedAt = Date.parse(row.payloadCreatedAt ?? '');
      if (
        !Number.isFinite(payloadCreatedAt) ||
        !row.payload ||
        !row.expiresAt ||
        row.expiresAt <= now ||
        !row.payloadCreatedAt ||
        payloadCreatedAt <= Date.now() - retention.payloadRetentionMs
      )
        return { ...evidence, matched: null, reason: 'payload_unavailable' };
      try {
        const payload: unknown = JSON.parse(row.payload);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw new Error('invalid');
        const result = evaluateFilters(
          parseWebhookPayload(row.eventType, payload as Record<string, unknown>),
          config.filters
        );
        // Filter reasons can contain draft values; no raw event text or sender details leave this operation.
        return { ...evidence, matched: result.matched, reason: safeFilterReason(result.reason) };
      } catch {
        return { ...evidence, matched: null, reason: 'payload_invalid' };
      }
    }),
  };
}

/** Never copy values derived from external content into preview evidence. */
function safeFilterReason(reason?: string): string {
  if (!reason) return 'matched';
  if (reason.startsWith('action ')) return 'Action does not match';
  if (reason.startsWith('missing required label')) return 'Required label is missing';
  if (reason.startsWith('actor ')) return 'Sender is ignored';
  if (reason.startsWith('branch ') || reason === 'no branch found in event')
    return 'Branch does not match';
  if (reason.startsWith('comment does not start')) return 'Command prefix does not match';
  if (reason.startsWith('no title/body/comment')) return 'Text does not match';
  return reason;
}
