/** Agent choices on an inbox reply. Ownership always comes from the verified source chat. */
import type { InboxItemCommentThread } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { OperationError } from './errors';
import type { AgentInboxSource } from './inbox-agent-reads';
import { parseRefOrNotFound } from './inbox-item-core';
import { inboxObservedReplyId, markInboxAgentActed } from './inbox-reply-core';
import { getInboxLimits } from './inbox-settings';
import { sanitizeUserInput } from './sanitize-user-input';
import type { OperationContext } from './types';

export const AgentRespondInputSchema = v.object({
  ref: v.string(),
  body: v.string(),
  replyMessageId: v.optional(v.string()),
});
export const AgentResolveInputSchema = v.object({ ref: v.string(), replyMessageId: v.string() });

/** Existing tasks use the raw ask id; other stores get a namespaced anchor. */
export function inboxCommentAnchor(ref: string): string {
  const parsed = parseRefOrNotFound(ref);
  return parsed.store === 'ask' ? parsed.id : ref;
}

export async function requireSourceItem(
  ctx: OperationContext,
  source: AgentInboxSource,
  ref: string
) {
  const parsed = parseRefOrNotFound(ref);
  if (parsed.store === 'attention') {
    const marker = await ctx.ports.inbox.attentionMarker(
      source.projectId,
      parsed.sessionId,
      parsed.markerId,
      source.userId
    );
    if (parsed.sessionId !== source.sessionId || !marker)
      throw new OperationError('not_found', 'Inbox item not found');
    return;
  }
  let query: string;
  const bindings: (string | number)[] = [parsed.id, source.projectId, source.sessionId];
  if (parsed.store === 'ask') {
    query = `SELECT id FROM asks WHERE id = ? AND project_id = ? AND source_session_id = ?
      AND kind IN ('question', 'review', 'result', 'task') AND status = 'open'
      AND (expires_at IS NULL OR expires_at > ?)`;
    bindings.push(Date.now());
  } else if (parsed.store === 'secret') {
    query = `SELECT id FROM runtime_secret_requests WHERE id = ? AND project_id = ?
      AND requesting_chat_session_id = ? AND status = 'pending' AND expires_at > ?`;
    bindings.push(Date.now());
  } else {
    query = `SELECT id FROM operations_action_approvals WHERE id = ? AND requesting_project_id = ?
      AND requesting_session_id = ? AND status = 'pending' AND expires_at > ?`;
    bindings.push(new Date().toISOString());
  }
  const row = await ctx.env.DATABASE.prepare(query)
    .bind(...bindings)
    .first();
  if (!row) throw new OperationError('not_found', 'Inbox item not found');
}

export async function respondToAgentInboxItem(
  ctx: OperationContext,
  source: AgentInboxSource,
  raw: v.InferInput<typeof AgentRespondInputSchema>
): Promise<{ ref: string; thread: InboxItemCommentThread }> {
  const input = v.parse(AgentRespondInputSchema, raw);
  const body = sanitizeUserInput(input.body).trim();
  const limits = await getInboxLimits(ctx);
  if (!body || body.length > limits.answerMaxChars)
    throw new OperationError(
      'invalid_input',
      `body must contain 1 to ${limits.answerMaxChars} characters`
    );
  await requireSourceItem(ctx, source, input.ref);
  const observedReplyId = await inboxObservedReplyId(
    ctx,
    source.projectId,
    input.ref,
    source.sessionId,
    input.replyMessageId
  );
  // Repeating this response in the same reply epoch repairs a failed D1 acknowledgement
  // through the comment core's durable receipt, without creating a second response thread.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([source.sessionId, input.ref, observedReplyId, body]))
    )
  );
  const clientMutationId = `inbox-response:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const created = await ctx.ports.inboxTasks.createComment(source.projectId, {
    askId: inboxCommentAnchor(input.ref),
    body,
    clientMutationId,
    actor: { kind: 'agent', id: source.sessionId, name: null },
  });
  await markInboxAgentActed(ctx, source.projectId, input.ref, observedReplyId);
  return { ref: input.ref, thread: created.thread };
}

export async function resolveAgentInboxItem(
  ctx: OperationContext,
  source: AgentInboxSource,
  raw: v.InferInput<typeof AgentResolveInputSchema>
): Promise<{ ref: string; status: 'answered'; messageId: string }> {
  const input = v.parse(AgentResolveInputSchema, raw);
  const parsed = parseRefOrNotFound(input.ref);
  if (parsed.store !== 'ask')
    throw new OperationError(
      'forbidden',
      'Only questions, reviews and results can be resolved by an agent'
    );
  const observedReplyId = await inboxObservedReplyId(
    ctx,
    source.projectId,
    input.ref,
    source.sessionId,
    input.replyMessageId
  );
  const now = Date.now();
  // Select the observed reply in the same statement that closes the ask. No human notice: the
  // agent already read the reply. Never resolve a different chat's item or a human task.
  const close = ctx.env.DATABASE.prepare(
    `UPDATE asks SET status = 'answered',
      answer_json = json_object('messageId', (SELECT message_id FROM inbox_replies
        WHERE project_id = asks.project_id AND item_ref = ? AND id = ?)),
      resolved_by_user_id = (SELECT user_id FROM inbox_replies
        WHERE project_id = asks.project_id AND item_ref = ? AND id = ?),
      resolved_at = ?, updated_at = ?, notified_at = ?
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND status = 'open'
        AND kind IN ('question', 'review', 'result')
        AND (expires_at IS NULL OR expires_at > ?)
        AND EXISTS (SELECT 1 FROM inbox_replies WHERE project_id = asks.project_id AND item_ref = ? AND id = ?)
        AND NOT EXISTS (SELECT 1 FROM inbox_replies WHERE project_id = asks.project_id
          AND item_ref = ? AND id != ? AND agent_acted_at IS NULL)
      RETURNING answer_json, kind, blocking`
  ).bind(
    input.ref,
    observedReplyId,
    input.ref,
    observedReplyId,
    now,
    now,
    now,
    parsed.id,
    source.projectId,
    source.sessionId,
    now,
    input.ref,
    observedReplyId,
    input.ref,
    observedReplyId
  );
  // Closing the ask and acknowledging its replies are one D1 transaction. Acknowledge only the
  // selected answer; every other unobserved reply must remain outstanding.
  const results = await ctx.env.DATABASE.batch([
    close,
    ctx.env.DATABASE.prepare(
      `UPDATE inbox_replies SET agent_acted_at = ?
       WHERE project_id = ? AND item_ref = ? AND id = (
         SELECT r.id FROM asks a JOIN inbox_replies r
           ON r.project_id = a.project_id AND r.item_ref = ?
             AND r.message_id = json_extract(a.answer_json, '$.messageId')
         WHERE a.id = ? AND a.project_id = ? AND a.source_session_id = ?
           AND a.status = 'answered' AND a.kind IN ('question', 'review', 'result'))`
    ).bind(
      now,
      source.projectId,
      input.ref,
      input.ref,
      parsed.id,
      source.projectId,
      source.sessionId
    ),
  ]);
  const closedRow = results[0]?.results?.[0];
  const closed =
    closedRow === undefined
      ? undefined
      : v.parse(
          v.object({
            answer_json: v.string(),
            kind: v.string(),
            blocking: v.number(),
          }),
          closedRow
        );
  if (!closed)
    throw new OperationError(
      'conflict',
      'No matching open item, or a newer reply must be handled first'
    );
  const answer = v.parse(v.object({ messageId: v.string() }), JSON.parse(closed.answer_json));
  if (closed.kind === 'question' && closed.blocking === 1)
    await ctx.ports.inbox.withdrawQuestion({
      projectId: source.projectId,
      sessionId: source.sessionId,
      askId: parsed.id,
    });
  return { ref: input.ref, status: 'answered', messageId: answer.messageId };
}
