/** Inbox replies use the authorized chat send and never archive the underlying request. */
import type {
  AcpInteractionBrowserAnswer,
  AgentMailboxMessage,
  InboxItem,
  InboxReplyRequest,
  InboxReplyResponse,
} from '@simple-agent-manager/shared';
import {
  AcpInteractionBrowserAnswerSchema,
  AcpInteractionIdSchema,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OperationError } from './errors';
import { requireActable } from './inbox-write-core';
import type { OperationContext } from './types';

export async function replyToInboxItem(
  ctx: OperationContext,
  input: InboxReplyRequest & { projectId: string; ref: string }
): Promise<InboxReplyResponse> {
  const { item, ref } = await requireActable(ctx, input, true);
  if (
    (!item.canAct || item.status !== 'open') &&
    !(item.kind === 'permission' && item.status === 'done')
  )
    throw new OperationError('forbidden', 'You cannot reply to this item');
  if (!item.sessionId)
    throw new OperationError('invalid_input', 'This inbox item has no source chat');
  const sessionId = item.sessionId;
  ctx.ports.chat.validateSendContent(input);
  const send = await ctx.ports.chat.authorizeSend(ctx.actor.userId, item.projectId, item.sessionId);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([input.content, input.attachments ?? []]))
    )
  );
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const binding = { ref: item.ref, sessionId, userId: ctx.actor.userId, fingerprint };
  // A prior acceptance may have committed while its RPC completion failed. Reconcile it
  // before minting another id or preparing a permission that may already be rejected.
  const prior = await ctx.env.DATABASE.prepare(
    `SELECT id, message_id, agent_acted_at FROM inbox_replies WHERE project_id = ? AND item_ref = ?
      AND user_id = ? ORDER BY id DESC LIMIT 1`
  )
    .bind(item.projectId, item.ref, ctx.actor.userId)
    .first<{ id: number; message_id: string; agent_acted_at: number | null }>();
  let resumeId: string | undefined;
  let retryPermission: { interactionId: string; answer: AcpInteractionBrowserAnswer } | undefined;
  if (prior?.agent_acted_at === null) {
    // If this read fails the ledger remains intact and no second delivery is created.
    const message = await ctx.ports.chat.getInboxReplyDelivery(item.projectId, prior.message_id);
    if (
      message &&
      (message.deliveryState === 'failed' || message.deliveryState === 'expired') &&
      item.kind === 'permission' &&
      message.metadata?.inboxReplyPermission !== undefined
    ) {
      assertReplySource(message, binding);
      const parsed = v.safeParse(
        v.object({
          interactionId: AcpInteractionIdSchema,
          answer: AcpInteractionBrowserAnswerSchema,
        }),
        message.metadata.inboxReplyPermission
      );
      if (!parsed.success || parsed.output.answer.decision.kind !== 'selected_option')
        throw new OperationError(
          'conflict',
          'The previous permission reply could not be reconciled'
        );
      retryPermission = parsed.output;
    }
    if (message?.metadata?.inboxReplyFingerprint === fingerprint) {
      assertReplyBinding(message, binding);
      // Only a new human POST may retry a terminal delivery. Retain its ledger: a delivery
      // outcome never brings the item back; only an agent response/update does that.
      // Expiry is not proof of nonreceipt, so this is an explicit resend, not an automatic retry.
      if (message.deliveryState !== 'failed' && message.deliveryState !== 'expired')
        return acceptedReply(message, binding);
    }
    // Absence cannot prove an older RPC will never commit. Resume the same delivery ID:
    // ProjectData's acceptance transaction chooses one payload and deduplicates both writers.
    if (!message) resumeId = prior.message_id;
  }
  if (resumeId && item.kind === 'permission' && item.status !== 'open')
    throw new OperationError(
      'conflict',
      'The permission was answered before this reply was accepted; inspect its chat'
    );
  const preparedPermission =
    ref.store === 'attention' ? await prepareReplyPermission(ctx, item, sessionId) : null;
  const permission =
    retryPermission ??
    (preparedPermission && item.answerSpec.type === 'interaction'
      ? { interactionId: item.answerSpec.interactionId ?? '', answer: preparedPermission }
      : undefined);
  const messageId = resumeId ?? ulid();
  let recorded = false;
  try {
    const accepted = await send.send(
      { content: input.content, attachments: input.attachments },
      undefined,
      {
        ref: item.ref,
        title: item.title,
        deliveryId: messageId,
        fingerprint,
        ...(permission
          ? {
              permission,
              async afterAcceptance() {
                // The canonical prompt is already durable. A failed immediate rejection is
                // retried by the delivery adapter before it can deliver this prompt.
                try {
                  await ctx.ports.chat.answerAgentInteraction(
                    ctx.actor.userId,
                    item.projectId,
                    sessionId,
                    permission.interactionId,
                    permission.answer
                  );
                } catch (error) {
                  console.warn(
                    JSON.stringify({
                      event: 'inbox.reply_permission_rejection_queued',
                      projectId: item.projectId,
                      ref: item.ref,
                      errorName: error instanceof Error ? error.name : 'Error',
                    })
                  );
                }
              },
            }
          : {}),
        async beforeDelivery() {
          // Before acceptance: even an immediate agent respond/update observes this reply.
          // Compare the same person's ledger position captured before the async send
          // preparation. A concurrent reply must reserve a new epoch before either can send.
          const sourceGuard: { sql: string; values: (string | number)[] } = { sql: '', values: [] };
          if (ref.store === 'ask') {
            sourceGuard.sql =
              "AND EXISTS (SELECT 1 FROM asks WHERE id = ? AND project_id = ? AND source_session_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?))";
            sourceGuard.values = [ref.id, item.projectId, sessionId, Date.now()];
          } else if (ref.store === 'secret') {
            sourceGuard.sql =
              "AND EXISTS (SELECT 1 FROM runtime_secret_requests WHERE id = ? AND project_id = ? AND requesting_chat_session_id = ? AND status = 'pending' AND expires_at > ?)";
            sourceGuard.values = [ref.id, item.projectId, sessionId, Date.now()];
          } else if (ref.store === 'approval') {
            sourceGuard.sql =
              "AND EXISTS (SELECT 1 FROM operations_action_approvals WHERE id = ? AND requesting_project_id = ? AND requesting_session_id = ? AND status = 'pending' AND expires_at > ?)";
            sourceGuard.values = [ref.id, item.projectId, sessionId, new Date().toISOString()];
          }
          const reservation = resumeId
            ? await ctx.env.DATABASE.prepare(
                `UPDATE inbox_replies SET id = id
                 WHERE project_id = ? AND item_ref = ? AND user_id = ? AND id = ? AND message_id = ?
                   AND agent_acted_at IS NULL AND id = (SELECT MAX(id) FROM inbox_replies
                     WHERE project_id = ? AND item_ref = ? AND user_id = ?)
                   ${sourceGuard.sql}`
              )
                .bind(
                  item.projectId,
                  item.ref,
                  ctx.actor.userId,
                  prior?.id ?? 0,
                  messageId,
                  item.projectId,
                  item.ref,
                  ctx.actor.userId,
                  ...sourceGuard.values
                )
                .run()
            : await ctx.env.DATABASE.prepare(
                `INSERT INTO inbox_replies (project_id, item_ref, user_id, message_id, replied_at, permission_rejected)
             SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(id) FROM inbox_replies
               WHERE project_id = ? AND item_ref = ? AND user_id = ?), 0) = ?
               ${sourceGuard.sql}`
              )
                .bind(
                  item.projectId,
                  item.ref,
                  ctx.actor.userId,
                  messageId,
                  Date.now(),
                  item.kind === 'permission' ? 1 : 0,
                  item.projectId,
                  item.ref,
                  ctx.actor.userId,
                  prior?.id ?? 0,
                  ...sourceGuard.values
                )
                .run();
          if (reservation.meta.changes !== 1)
            throw new OperationError(
              'conflict',
              'The item changed or another inbox reply was accepted; refresh before retrying'
            );
          recorded = true;
        },
      }
    );
    if (typeof accepted.messageId !== 'string' || typeof accepted.deliveryId !== 'string')
      throw new OperationError('conflict', 'Inbox replies require durable chat delivery');
    // Either writer can win fixed-ID acceptance, whose intent comparison excludes trusted
    // metadata. Validate the canonical winner before either original or resumed POST says 202.
    const message = await ctx.ports.chat.getInboxReplyDelivery(item.projectId, messageId);
    if (!message)
      throw new OperationError(
        'conflict',
        'Inbox reply acceptance is not yet available; retry shortly'
      );
    return acceptedReply(message, binding);
  } catch (error) {
    if (recorded) {
      // A failed or absent receipt cannot fence a delayed RPC. Keep this reservation so an
      // explicit retry resumes the same ID instead of racing a second canonical delivery.
      const message = await ctx.ports.chat.getInboxReplyDelivery(item.projectId, messageId);
      if (message) return acceptedReply(message, binding);
    }
    throw error;
  }
}

interface ReplyBinding {
  ref: string;
  sessionId: string;
  userId: string;
  fingerprint: string;
}

function assertReplySource(message: AgentMailboxMessage, binding: ReplyBinding): void {
  if (
    message.sourceKind !== 'inbox_reply' ||
    message.targetSessionId !== binding.sessionId ||
    message.senderType !== 'human' ||
    message.senderId !== binding.userId ||
    message.metadata?.inboxRef !== binding.ref
  )
    throw new OperationError('conflict', 'The previous inbox reply could not be reconciled');
}
function assertReplyBinding(message: AgentMailboxMessage, binding: ReplyBinding): void {
  assertReplySource(message, binding);
  if (message.metadata?.inboxReplyFingerprint !== binding.fingerprint)
    throw new OperationError('conflict', 'The previous inbox reply could not be reconciled');
}
function acceptedReply(message: AgentMailboxMessage, binding: ReplyBinding): InboxReplyResponse {
  assertReplyBinding(message, binding);
  if (message.deliveryState === 'ambiguous')
    throw new OperationError(
      'conflict',
      'The previous inbox reply may have reached the agent; inspect its chat before sending it again'
    );
  if (message.deliveryState === 'failed' || message.deliveryState === 'expired')
    throw new OperationError(
      'conflict',
      'The previous inbox reply is no longer queued; inspect its chat before replying again'
    );
  return {
    ref: binding.ref,
    sessionId: binding.sessionId,
    status: 'queued',
    messageId: message.promptMessageId,
    deliveryId: message.id,
  };
}

/** Prepare the request's own reject option without deciding what the person's reply means. */
async function prepareReplyPermission(
  ctx: OperationContext,
  item: InboxItem,
  sessionId: string
): Promise<AcpInteractionBrowserAnswer | null> {
  if (
    item.kind !== 'permission' ||
    item.status !== 'open' ||
    item.answerSpec.type !== 'interaction'
  )
    return null;
  const pending = await ctx.ports.connector.pendingInteractions(item.projectId, sessionId);
  const interactionId = item.answerSpec.interactionId;
  const request = pending.find((p) => p.interactionId === interactionId);
  const options = (request?.answerOptions ?? []).flatMap((option) => {
    if (
      !option ||
      typeof option !== 'object' ||
      !('id' in option) ||
      !('kind' in option) ||
      typeof option.id !== 'string'
    )
      return [];
    return option.kind === 'reject_once' || option.kind === 'reject_always'
      ? [{ id: option.id, kind: option.kind }]
      : [];
  });
  const reject = options.find((o) => o.kind === 'reject_once') ?? options[0];
  if (!reject)
    throw new OperationError(
      'conflict',
      'This permission has no reject option; answer it in the chat'
    );
  return await ctx.ports.connector.prepareAgentAnswer(
    item.projectId,
    sessionId,
    item.answerSpec.interactionId ?? '',
    { optionId: reject.id }
  );
}

/** Resolve exactly the delivery the agent observed, independent of reservation or acceptance order. */
export async function inboxObservedReplyId(
  ctx: OperationContext,
  projectId: string,
  ref: string,
  sessionId: string,
  replyMessageId?: string
): Promise<number> {
  if (replyMessageId === undefined) {
    const pending = await ctx.env.DATABASE.prepare(
      'SELECT id FROM inbox_replies WHERE project_id = ? AND item_ref = ? AND agent_acted_at IS NULL LIMIT 1'
    )
      .bind(projectId, ref)
      .first();
    if (pending)
      throw new OperationError(
        'conflict',
        'Pass replyMessageId from the inbox reply header you received'
      );
    return 0;
  }
  const row = await ctx.env.DATABASE.prepare(
    'SELECT id FROM inbox_replies WHERE project_id = ? AND item_ref = ? AND message_id = ?'
  )
    .bind(projectId, ref, replyMessageId)
    .first<{ id: number }>();
  if (!row) throw new OperationError('not_found', 'Inbox reply not found');
  const message = await ctx.ports.chat.getInboxReplyDelivery(projectId, replyMessageId);
  if (
    !message ||
    message.sourceKind !== 'inbox_reply' ||
    message.targetSessionId !== sessionId ||
    message.senderType !== 'human' ||
    message.metadata?.inboxRef !== ref
  )
    throw new OperationError('conflict', 'Inbox reply does not belong to this chat and item');
  return row.id;
}

/** Only agent respond/update acknowledges replies, never a person's task edit or a heartbeat. */
export async function markInboxAgentActed(
  ctx: OperationContext,
  projectId: string,
  ref: string,
  observedReplyId: number,
  sourceGuard: { sql: string; values: (string | number)[] }
): Promise<void> {
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE inbox_replies SET agent_acted_at = ?
      WHERE project_id = ? AND item_ref = ? AND id = ? AND EXISTS (${sourceGuard.sql})`
  )
    .bind(Date.now(), projectId, ref, observedReplyId, ...sourceGuard.values)
    .run();
  if ((result.meta?.changes ?? 0) !== 1)
    throw new OperationError('conflict', 'The inbox item changed while storing the response');
}
