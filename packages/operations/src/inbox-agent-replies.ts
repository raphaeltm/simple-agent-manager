/** Agent choices on an inbox reply. Ownership always comes from the verified source chat. */
import type { InboxItemCommentThread } from '@simple-agent-manager/shared';
import { sanitizeUserInput } from './sanitize-user-input';
import * as v from 'valibot';

import { OperationError } from './errors';
import type { AgentInboxSource } from './inbox-agent-reads';
import { parseRefOrNotFound } from './inbox-item-core';
import { markInboxAgentActed } from './inbox-reply-core';
import { getInboxLimits } from './inbox-settings';
import type { OperationContext } from './types';

export const AgentRespondInputSchema = v.object({ ref: v.string(), body: v.string() });
export const AgentResolveInputSchema = v.object({ ref: v.string() });

/** Existing tasks use the raw ask id; other stores get a namespaced anchor. */
export function inboxCommentAnchor(ref: string): string {
  const parsed = parseRefOrNotFound(ref);
  return parsed.store === 'ask' ? parsed.id : ref;
}

async function requireSourceItem(ctx: OperationContext, source: AgentInboxSource, ref: string) {
  const parsed = parseRefOrNotFound(ref);
  if (parsed.store === 'attention') {
    const marker = await ctx.ports.inbox.attentionMarker(source.projectId, parsed.sessionId,
      parsed.markerId, source.userId);
    if (parsed.sessionId !== source.sessionId || !marker)
      throw new OperationError('not_found', 'Inbox item not found');
    return;
  }
  const query = parsed.store === 'ask'
    ? `SELECT id FROM asks WHERE id = ? AND project_id = ? AND source_session_id = ?
        AND kind IN ('question', 'review', 'result', 'task') AND status = 'open'`
    : parsed.store === 'secret'
      ? `SELECT id FROM runtime_secret_requests WHERE id = ? AND project_id = ?
          AND requesting_chat_session_id = ? AND status = 'pending' AND expires_at > ${Date.now()}`
      : `SELECT id FROM operations_action_approvals WHERE id = ? AND requesting_project_id = ?
          AND requesting_session_id = ? AND status = 'pending'`;
  const row = await ctx.env.DATABASE.prepare(query)
    .bind(parsed.id, source.projectId, source.sessionId).first();
  if (!row) throw new OperationError('not_found', 'Inbox item not found');
}

export async function respondToAgentInboxItem(
  ctx: OperationContext, source: AgentInboxSource, raw: v.InferInput<typeof AgentRespondInputSchema>
): Promise<{ ref: string; thread: InboxItemCommentThread }> {
  const input = v.parse(AgentRespondInputSchema, raw);
  const body = sanitizeUserInput(input.body).trim();
  const limits = await getInboxLimits(ctx);
  if (!body || body.length > limits.answerMaxChars)
    throw new OperationError('invalid_input', `body must contain 1 to ${limits.answerMaxChars} characters`);
  await requireSourceItem(ctx, source, input.ref);
  const actedAt = Date.now();
  const created = await ctx.ports.inboxTasks.createComment(source.projectId, {
    askId: inboxCommentAnchor(input.ref), body,
    actor: { kind: 'agent', id: source.sessionId, name: null },
  });
  await markInboxAgentActed(ctx, source.projectId, input.ref, actedAt);
  return { ref: input.ref, thread: created.thread };
}

export async function resolveAgentInboxItem(
  ctx: OperationContext, source: AgentInboxSource, raw: v.InferInput<typeof AgentResolveInputSchema>
): Promise<{ ref: string; status: 'answered'; messageId: string }> {
  const input = v.parse(AgentResolveInputSchema, raw);
  const parsed = parseRefOrNotFound(input.ref);
  if (parsed.store !== 'ask')
    throw new OperationError('forbidden', 'Only questions, reviews and results can be resolved by an agent');
  const now = Date.now();
  // Select the latest reply in the same statement that closes the ask. No human notice: the
  // agent already read the reply. Never resolve a different chat's item or a human task.
  const closed = await ctx.env.DATABASE.prepare(
    `UPDATE asks SET status = 'answered',
      answer_json = json_object('messageId', (SELECT message_id FROM inbox_replies
        WHERE project_id = asks.project_id AND item_ref = ?
        ORDER BY replied_at DESC, message_id DESC LIMIT 1)),
      resolved_by_user_id = (SELECT user_id FROM inbox_replies
        WHERE project_id = asks.project_id AND item_ref = ?
        ORDER BY replied_at DESC, message_id DESC LIMIT 1),
      resolved_at = ?, updated_at = ?, notified_at = ?
      WHERE id = ? AND project_id = ? AND source_session_id = ? AND status = 'open'
        AND kind IN ('question', 'review', 'result')
        AND EXISTS (SELECT 1 FROM inbox_replies WHERE project_id = asks.project_id AND item_ref = ?)
      RETURNING answer_json, kind, blocking`
  ).bind(input.ref, input.ref, now, now, now, parsed.id, source.projectId, source.sessionId, input.ref)
    .first<{ answer_json: string; kind: string; blocking: number }>();
  if (!closed) throw new OperationError('conflict', 'No open question, review or result with a reply belongs to this chat');
  const answer = v.parse(v.object({ messageId: v.string() }), JSON.parse(closed.answer_json));
  if (closed.kind === 'question' && closed.blocking === 1)
    await ctx.ports.inbox.withdrawQuestion({ projectId: source.projectId,
      sessionId: source.sessionId, askId: parsed.id });
  return { ref: input.ref, status: 'answered', messageId: answer.messageId };
}
