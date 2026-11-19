/**
 * Tells the agent that asked for a secret what happened to its request, as a durable prompt
 * (source kind `secret_request`). The prompt is metadata only: the secret value is never in it.
 * Delivery is guarded on the requesting task's stable authority, so it wakes the session only
 * while that task, or its own session-recovery successor, is live (`sourceTaskGuardForClaim`).
 */
import { buildSamNotice, type SamNotice } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';

import type * as schema from '../db/schema';
import { projectMembers } from '../db/schema';
import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { projectMemberRolesWithCapability } from '../middleware/project-auth';
import { buildActionUrl, sendNotification } from './notification';
import * as projectDataService from './project-data';
import { type Db, isoOrNull } from './runtime-secret-request-records';
import { safeNotice } from './sam-notice-builders';

type Outcome = 'fulfilled' | 'declined' | 'expired';

export function runtimeSecretRequestDeliveryId(requestId: string): string {
  return `secret-request:${requestId}`;
}

function expiryText(secretExpiresAt: number | null): string {
  const iso = isoOrNull(secretExpiresAt);
  return iso
    ? `It expires at ${iso}; after that exec_with_secrets refuses it.`
    : 'It has no expiry.';
}

/** The agent-facing text. Names and IDs only; never the value. */
export function buildRuntimeSecretRequestPrompt(
  row: schema.RuntimeSecretRequestRow,
  outcome: Outcome,
  resolvedByName: string | null
): string {
  const who = resolvedByName ? ` by ${resolvedByName}` : '';
  switch (outcome) {
    case 'fulfilled':
      return [
        `Secret request ${row.id} was fulfilled${who}: ${row.envKey} is now a project runtime secret.`,
        `Use it with exec_with_secrets and secretNames ["${row.envKey}"]. The value is not shown to you; do not ask for it in chat. ${expiryText(row.secretExpiresAt)}`,
        `Project secrets are shared: every project member's agent sessions can use ${row.envKey}.`,
      ].join('\n');
    case 'declined':
      return `Secret request ${row.id} for ${row.envKey} was declined${who}. Do not wait for it; continue without it or explain what you need.`;
    case 'expired':
      return `Secret request ${row.id} for ${row.envKey} expired before anyone supplied a value. Do not wait for it; ask again with request_secret only if you still need it.`;
  }
}

function secretRequestNotice(
  row: schema.RuntimeSecretRequestRow,
  outcome: Outcome,
  resolvedByName: string | null
): SamNotice {
  const headline =
    outcome === 'fulfilled'
      ? `Secret ${row.envKey} supplied`
      : outcome === 'declined'
        ? `Secret request for ${row.envKey} declined`
        : `Secret request for ${row.envKey} expired`;
  const detail =
    outcome === 'fulfilled'
      ? [
          resolvedByName ? `Supplied by ${resolvedByName}.` : null,
          'The agent was told the name only, never the value.',
          isoOrNull(row.secretExpiresAt) ? `Expires ${isoOrNull(row.secretExpiresAt)}.` : null,
        ]
          .filter(Boolean)
          .join(' ')
      : 'The agent was told not to wait for it.';
  return buildSamNotice({
    type: `secret_request.${outcome}`,
    headline,
    detail,
    severity: outcome === 'fulfilled' ? 'success' : 'info',
    refs: [{ kind: 'task', id: row.requestingTaskId, label: null }],
  });
}

/** Best-effort; returns whether the prompt was queued. Never throws. */
export async function deliverRuntimeSecretRequestOutcome(
  env: Env,
  row: schema.RuntimeSecretRequestRow,
  outcome: Outcome,
  resolvedByName: string | null
): Promise<boolean> {
  const config = resolveDurableExecutionConfig(env);
  if (!config.deliveryEnabled) {
    log.warn('runtime_secret_request.delivery_disabled', { requestId: row.id });
    return false;
  }
  const content = buildRuntimeSecretRequestPrompt(row, outcome, resolvedByName);
  try {
    await projectDataService.acceptPromptDelivery(env, row.projectId, {
      deliveryId: runtimeSecretRequestDeliveryId(row.id),
      targetSessionId: row.requestingChatSessionId,
      displayContent: content,
      deliveryContent: content,
      sourceTaskId: row.requestingAuthorityTaskId,
      senderType: 'system',
      senderId: row.resolvedBy,
      messageClass: 'deliver',
      sourceKind: 'secret_request',
      ttlMs: config.ttlMs,
      metadata: {
        secretRequestId: row.id,
        envKey: row.envKey,
        outcome,
        // The requester must still be an active project member when the wake is claimed.
        creatorUserId: row.requesterUserId,
      },
      notice: safeNotice(() => secretRequestNotice(row, outcome, resolvedByName), {
        secretRequestId: row.id,
      }),
    });
    return true;
  } catch (error) {
    log.error('runtime_secret_request.delivery_failed', {
      requestId: row.id,
      projectId: row.projectId,
      sessionId: row.requestingChatSessionId,
      outcome,
      ...serializeError(error),
    });
    return false;
  }
}

/**
 * Who is told a value is wanted: the person whose agent asked (they own the chat and see the
 * card first). If that person cannot supply it (no `secret:write`, e.g. a maintainer), every
 * active member who can is told too, so the request never waits on nobody. Bounded by the
 * project's membership. A failed lookup falls back to the requester alone.
 */
async function secretRequestRecipients(
  db: Db,
  row: schema.RuntimeSecretRequestRow
): Promise<string[]> {
  try {
    const writers = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, row.projectId),
          eq(projectMembers.status, 'active'),
          inArray(projectMembers.role, projectMemberRolesWithCapability('secret:write'))
        )
      );
    const writerIds = writers.map((writer) => writer.userId);
    if (writerIds.includes(row.requesterUserId)) return [row.requesterUserId];
    return [row.requesterUserId, ...writerIds];
  } catch (error) {
    log.warn('runtime_secret_request.recipients_failed', {
      requestId: row.id,
      projectId: row.projectId,
      ...serializeError(error),
    });
    return [row.requesterUserId];
  }
}

/** Tell people a value is wanted. Best-effort: the card in the chat is the record. */
export async function notifyRuntimeSecretRequested(
  env: Env,
  db: Db,
  row: schema.RuntimeSecretRequestRow
): Promise<boolean> {
  if (!env.NOTIFICATION) return false;
  const recipients = await secretRequestRecipients(db, row);
  const results = await Promise.allSettled(
    recipients.map((userId) =>
      sendNotification(env, userId, {
        type: 'secret_request',
        urgency: 'high',
        title: `Secret requested: ${row.envKey}`,
        body: row.reason.slice(0, 500),
        projectId: row.projectId,
        taskId: row.requestingTaskId,
        sessionId: row.requestingChatSessionId,
        actionUrl: buildActionUrl(row.projectId, row.requestingChatSessionId),
        metadata: { secretRequestId: row.id, envKey: row.envKey },
      })
    )
  );
  let sent = false;
  for (const result of results) {
    if (result.status === 'fulfilled') sent ||= result.value.id !== 'suppressed';
    else
      log.warn('runtime_secret_request.notify_failed', {
        requestId: row.id,
        ...serializeError(result.reason),
      });
  }
  return sent;
}
