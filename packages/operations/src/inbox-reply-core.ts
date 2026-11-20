/** Inbox replies use the authorized chat send and never archive the underlying request. */
import type { InboxReplyRequest, InboxReplyResponse } from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';

import { OperationError } from './errors';
import { requireActable } from './inbox-write-core';
import type { OperationContext } from './types';

export async function replyToInboxItem(
  ctx: OperationContext,
  input: InboxReplyRequest & { projectId: string; ref: string }
): Promise<InboxReplyResponse> {
  const { item, ref } = await requireActable(ctx, input);
  if (!item.canAct || item.status !== 'open')
    throw new OperationError('forbidden', 'You cannot reply to this item');
  if (!item.sessionId)
    throw new OperationError('invalid_input', 'This inbox item has no source chat');
  ctx.ports.chat.validateSendContent(input);
  const send = await ctx.ports.chat.authorizeSend(ctx.actor.userId, item.projectId, item.sessionId);
  // Preflight permission rejection through the existing answer preparation. Its reject option
  // is authoritative; never guess an option id or send an implicit grant.
  const permission = ref.store === 'attention' && item.kind === 'permission' &&
    item.answerSpec.type === 'interaction'
    ? await ctx.ports.connector.prepareAgentAnswer(item.projectId, item.sessionId,
        item.answerSpec.interactionId ?? '', { decline: true })
    : null;
  const messageId = ulid();
  let recorded = false;
  try {
    const accepted = await send.send({ content: input.content, attachments: input.attachments }, undefined, {
      ref: item.ref,
      title: item.title,
      deliveryId: messageId,
      async beforeDelivery() {
        if (permission && item.answerSpec.type === 'interaction') {
          await ctx.ports.chat.answerAgentInteraction(ctx.actor.userId, item.projectId,
            item.sessionId!, item.answerSpec.interactionId ?? '', permission);
        }
        // Before acceptance: even an immediate agent respond/update observes this reply.
        await ctx.env.DATABASE.prepare(
          'INSERT INTO inbox_replies (project_id, item_ref, user_id, message_id, replied_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(item.projectId, item.ref, ctx.actor.userId, messageId, Date.now()).run();
        recorded = true;
      },
    });
    if (typeof accepted.messageId !== 'string' || typeof accepted.deliveryId !== 'string')
      throw new OperationError('conflict', 'Inbox replies require durable chat delivery');
    return { ref: item.ref, sessionId: item.sessionId, status: 'queued',
      messageId: accepted.messageId, deliveryId: accepted.deliveryId };
  } catch (error) {
    // A failed acceptance must not strand the item outside the inbox. Never delete other replies.
    if (recorded) await ctx.env.DATABASE.prepare(
      'DELETE FROM inbox_replies WHERE project_id = ? AND item_ref = ? AND message_id = ?'
    ).bind(item.projectId, item.ref, messageId).run();
    throw error;
  }
}

/** Called only by the agent action that owns resurfacing, with its observation instant. */
export async function markInboxAgentActed(
  ctx: OperationContext, projectId: string, ref: string, actedAt: number
): Promise<void> {
  await ctx.env.DATABASE.prepare(
    `UPDATE inbox_replies SET agent_acted_at = ?
      WHERE project_id = ? AND item_ref = ? AND replied_at <= ?`
  ).bind(actedAt, projectId, ref, actedAt).run();
}
