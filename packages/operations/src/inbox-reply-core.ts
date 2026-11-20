/** Inbox replies use the authorized chat send and never archive the underlying request. */
import type {
  AcpInteractionBrowserAnswer,
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
  ctx.ports.chat.validateSendContent(input);
  const send = await ctx.ports.chat.authorizeSend(ctx.actor.userId, item.projectId, item.sessionId);
  // Preflight permission rejection through the existing answer preparation. Its reject option
  // is authoritative; never guess an option id or send an implicit grant.
  let permission: AcpInteractionBrowserAnswer | null = null;
  if (
    ref.store === 'attention' &&
    item.kind === 'permission' &&
    item.status === 'open' &&
    item.answerSpec.type === 'interaction'
  ) {
    const pending = await ctx.ports.connector.pendingInteractions(item.projectId, item.sessionId);
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
    permission = await ctx.ports.connector.prepareAgentAnswer(
      item.projectId,
      item.sessionId,
      item.answerSpec.interactionId ?? '',
      { optionId: reject.id }
    );
  }
  const preparedPermission = permission;
  const messageId = ulid();
  const sessionId = item.sessionId;
  let recorded = false;
  try {
    const accepted = await send.send(
      { content: input.content, attachments: input.attachments },
      undefined,
      {
        ref: item.ref,
        title: item.title,
        deliveryId: messageId,
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
          await ctx.env.DATABASE.prepare(
            'INSERT INTO inbox_replies (project_id, item_ref, user_id, message_id, replied_at, permission_rejected) VALUES (?, ?, ?, ?, ?, ?)'
          )
            .bind(
              item.projectId,
              item.ref,
              ctx.actor.userId,
              messageId,
              Date.now(),
              item.kind === 'permission' ? 1 : 0
            )
            .run();
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
    // A failed acceptance must not strand the item outside the inbox. Never delete other replies.
    if (recorded)
      await ctx.env.DATABASE.prepare(
        'DELETE FROM inbox_replies WHERE project_id = ? AND item_ref = ? AND message_id = ?'
      )
        .bind(item.projectId, item.ref, messageId)
        .run();
    throw error;
  }
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
