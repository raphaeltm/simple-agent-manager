/**
 * Tells the agent that filed an inbox ask what happened to it, as a durable prompt (source kind
 * `inbox_ask`), the way `runtime-secret-request-delivery.ts` tells an agent about its secret
 * request. Delivery is guarded on the filing task (`sourceTaskGuardForClaim`), so it wakes the
 * session only while that task, or its own session-recovery successor, is live, and only while
 * the person named in `creatorUserId` is still an active member.
 */
import type { InboxAskNoticeOutcome, InboxAskNoticeRow } from '@simple-agent-manager/operations';
import { buildSamNotice, type SamNotice } from '@simple-agent-manager/shared';

import { resolveDurableExecutionConfig } from '../../durable-objects/project-data/durable-execution-config';
import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import * as projectDataService from '../project-data';
import { safeNotice } from '../sam-notice-builders';

export function inboxAskDeliveryId(askId: string): string {
  return `inbox-ask:${askId}`;
}

function answerText(answerJson: string | null): string | null {
  if (!answerJson) return null;
  try {
    const parsed = JSON.parse(answerJson) as unknown;
    const text =
      parsed && typeof parsed === 'object' && 'text' in parsed
        ? (parsed as { text: unknown }).text
        : null;
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}

/** The agent-facing text. */
export function buildInboxAskPrompt(
  row: InboxAskNoticeRow,
  outcome: InboxAskNoticeOutcome
): string {
  // Title and answer were bounded when written (`inbox.titleMaxChars`, `inbox.answerMaxChars`).
  const item = `inbox item ${row.id} ("${row.title}")`;
  const answer = answerText(row.answerJson);
  switch (outcome) {
    case 'answered':
      return answer
        ? `The person answered your ${item}:\n\n${answer}`
        : `The person answered your ${item}.`;
    case 'done':
      return answer
        ? `The person marked your ${item} done, with this comment:\n\n${answer}`
        : `The person marked your ${item} done.`;
    case 'archived':
      return `The person archived your ${item} and will not act on it. Do not wait for it: continue without it, or file a new item only if something changed.`;
    case 'expired':
      return `Your ${item} expired before anyone acted on it. Do not wait for it.`;
  }
}

function askNotice(row: InboxAskNoticeRow, outcome: InboxAskNoticeOutcome): SamNotice {
  return buildSamNotice({
    type: `inbox_ask.${outcome}`,
    headline:
      outcome === 'archived'
        ? 'Inbox item archived'
        : outcome === 'expired'
          ? 'Inbox item expired'
          : outcome === 'done'
            ? 'Inbox item done'
            : 'Inbox item answered',
    detail:
      outcome === 'archived' || outcome === 'expired'
        ? 'The agent was told not to wait for it.'
        : 'The agent was given the answer.',
    severity: outcome === 'archived' || outcome === 'expired' ? 'info' : 'success',
    refs: row.sourceTaskId ? [{ kind: 'task', id: row.sourceTaskId, label: null }] : [],
  });
}

/** Best-effort; true when the prompt was queued or there is no agent to tell. Never throws. */
export async function deliverInboxAskNotice(
  env: Env,
  row: InboxAskNoticeRow,
  outcome: InboxAskNoticeOutcome
): Promise<boolean> {
  // Nothing filed it from a chat, so there is no agent to tell.
  if (!row.sourceSessionId) return true;
  const creatorUserId = row.resolvedByUserId ?? row.assigneeUserId;
  if (!creatorUserId || !row.sourceTaskId) {
    // The delivery guard needs both; without them the notice could wake an unrelated chat.
    log.warn('inbox_ask.notice_unaddressable', {
      askId: row.id,
      projectId: row.projectId,
      hasTask: Boolean(row.sourceTaskId),
      hasPerson: Boolean(creatorUserId),
    });
    return true;
  }
  const config = resolveDurableExecutionConfig(env);
  if (!config.deliveryEnabled) {
    log.warn('inbox_ask.delivery_disabled', { askId: row.id });
    return false;
  }
  const content = buildInboxAskPrompt(row, outcome);
  try {
    await projectDataService.acceptPromptDelivery(env, row.projectId, {
      deliveryId: inboxAskDeliveryId(row.id),
      targetSessionId: row.sourceSessionId,
      displayContent: content,
      deliveryContent: content,
      sourceTaskId: row.sourceTaskId,
      senderType: 'system',
      senderId: row.resolvedByUserId,
      messageClass: 'deliver',
      sourceKind: 'inbox_ask',
      ttlMs: config.ttlMs,
      metadata: { askId: row.id, outcome, creatorUserId },
      notice: safeNotice(() => askNotice(row, outcome), { askId: row.id }),
    });
    return true;
  } catch (error) {
    log.error('inbox_ask.delivery_failed', {
      askId: row.id,
      projectId: row.projectId,
      sessionId: row.sourceSessionId,
      outcome,
      ...serializeError(error),
    });
    return false;
  }
}
