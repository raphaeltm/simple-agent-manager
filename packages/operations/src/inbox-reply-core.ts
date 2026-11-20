/** Inbox replies use the authorized chat send and never archive the underlying request. */
import type {
  AcpInteractionBrowserAnswer,
  AgentMailboxMessage,
  InboxItem,
  InboxReplyRequest,
  InboxReplyResponse,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';

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
  if (prior?.agent_acted_at === null) {
    // If this read fails the ledger remains intact and no second delivery is created.
    const message = await ctx.ports.chat.getInboxReplyDelivery(item.projectId, prior.message_id);
    if (message?.metadata?.inboxReplyFingerprint === fingerprint) {
      assertReplyBinding(message, binding);
      // Only a new human POST may retry a terminal delivery. Retain its ledger: a delivery
      // outcome never brings the item back; only an agent response/update does that.
      // Expiry is not proof of nonreceipt, so this is an explicit resend, not an automatic retry.
      if (message.deliveryState !== 'failed' && message.deliveryState !== 'expired')
        return acceptedReply(message, binding);
    }
    // This may be another request between its D1 reservation and DO acceptance. Only
    // that request can roll back its own reservation after a definitive failed acceptance.
    if (!message)
      throw new OperationError(
        'conflict',
        'The previous inbox reply is still being accepted; retry shortly'
      );
  }
  const preparedPermission =
    ref.store === 'attention' ? await prepareReplyPermission(ctx, item, sessionId) : null;
  const messageId = ulid();
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
        ...(preparedPermission && item.answerSpec.type === 'interaction'
          ? {
              permission: {
                interactionId: item.answerSpec.interactionId ?? '',
                answer: preparedPermission,
              },
              async afterAcceptance() {
                // The canonical prompt is already durable. A failed immediate rejection is
                // retried by the delivery adapter before it can deliver this prompt.
                try {
                  await ctx.ports.chat.answerAgentInteraction(
                    ctx.actor.userId,
                    item.projectId,
                    sessionId,
                    item.answerSpec.type === 'interaction'
                      ? (item.answerSpec.interactionId ?? '')
                      : '',
                    preparedPermission
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
          const reservation = await ctx.env.DATABASE.prepare(
            `INSERT INTO inbox_replies (project_id, item_ref, user_id, message_id, replied_at, permission_rejected)
             SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(id) FROM inbox_replies
               WHERE project_id = ? AND item_ref = ? AND user_id = ?), 0) = ?`
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
              prior?.id ?? 0
            )
            .run();
          if (reservation.meta.changes !== 1)
            throw new OperationError(
              'conflict',
              'Another inbox reply was accepted; retry after it finishes'
            );
          recorded = true;
        },
      }
    );
    if (typeof accepted.messageId !== 'string' || typeof accepted.deliveryId !== 'string')
      throw new OperationError('conflict', 'Inbox replies require durable chat delivery');
    return {
      ref: item.ref,
      sessionId: item.sessionId,
      status: 'queued',
      messageId: accepted.messageId,
      deliveryId: accepted.deliveryId,
    };
  } catch (error) {
    if (recorded) {
      // SQL acceptance precedes fallible finalizers in ProjectData. Only a definitive
      // absence authorizes rollback; an unavailable lookup retains the durable ledger.
      const message = await ctx.ports.chat.getInboxReplyDelivery(item.projectId, messageId);
      if (message) return acceptedReply(message, binding);
      await ctx.env.DATABASE.prepare(
        'DELETE FROM inbox_replies WHERE project_id = ? AND item_ref = ? AND message_id = ?'
      )
        .bind(item.projectId, item.ref, messageId)
        .run();
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

function assertReplyBinding(message: AgentMailboxMessage, binding: ReplyBinding): void {
  if (
    message.sourceKind !== 'inbox_reply' ||
    message.targetSessionId !== binding.sessionId ||
    message.senderType !== 'human' ||
    message.senderId !== binding.userId ||
    message.metadata?.inboxRef !== binding.ref ||
    message.metadata?.inboxReplyFingerprint !== binding.fingerprint
  )
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

/** Capture before an agent response awaits another store. A later human reply must stay hidden. */
export async function inboxReplyWatermark(
  ctx: OperationContext,
  projectId: string,
  ref: string
): Promise<number> {
  const row = await ctx.env.DATABASE.prepare(
    'SELECT COALESCE(MAX(id), 0) AS watermark FROM inbox_replies WHERE project_id = ? AND item_ref = ?'
  )
    .bind(projectId, ref)
    .first<{ watermark: number }>();
  return Number(row?.watermark ?? 0);
}

/** Only agent respond/update acknowledges replies, never a person's task edit or a heartbeat. */
export async function markInboxAgentActed(
  ctx: OperationContext,
  projectId: string,
  ref: string,
  watermark: number
): Promise<void> {
  await ctx.env.DATABASE.prepare(
    `UPDATE inbox_replies SET agent_acted_at = ?
      WHERE project_id = ? AND item_ref = ? AND id <= ?`
  )
    .bind(Date.now(), projectId, ref, watermark)
    .run();
}
