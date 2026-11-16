/**
 * ProjectData's side of agent questions held in D1 `asks` (inbox slice G, idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9). The ask is one D1 row; this object keeps no copy of it. It does
 * what a question marker used to do inside the object:
 * - a person's chat message answers the chat's open questions, as it resolved every marker
 *   (`message-persistence.ts:resolveAttentionForRoles`, `durability-foundation.ts`);
 * - the live `attention.*` socket events the chat list follows.
 */
import { createModuleLogger, serializeError } from '@simple-agent-manager/worker-core';

import type { Env } from './types';

const log = createModuleLogger('project_data.question_asks');

type Broadcast = (type: string, payload: Record<string, unknown>, sessionId?: string) => void;

/**
 * Close the chat's open questions because the person wrote to the agent in the chat. The message
 * itself reached the agent, so no notice is queued (`notified_at` is set). Bound to the project
 * and the chat (rule 11). A failure is logged, never thrown: the message is already persisted,
 * and the question still expires on its schedule, where `ProjectData.expireQuestionAsk` sees
 * the message and does not stop the task.
 */
export async function closeQuestionAsksForHumanMessage(
  env: Env,
  input: { projectId: string | null; sessionId: string; messageId: string | null },
  broadcast: Broadcast
): Promise<number> {
  if (!input.projectId) return 0;
  const now = Date.now();
  try {
    const result = await env.DATABASE.prepare(
      `UPDATE asks
          SET status = 'answered', answer_json = ?, resolved_at = ?, updated_at = ?, notified_at = ?
        WHERE project_id = ? AND source_session_id = ? AND kind = 'question' AND status = 'open'
        RETURNING id`
    )
      .bind(
        JSON.stringify({ via: 'chat_message', messageId: input.messageId }),
        now,
        now,
        now,
        input.projectId,
        input.sessionId
      )
      .all<{ id: string }>();
    const ids = (result.results ?? []).map((row) => row.id).filter(Boolean);
    for (const askId of ids) {
      broadcast(
        'attention.resolved',
        { sessionId: input.sessionId, markerId: askId, reason: 'human_message' },
        input.sessionId
      );
    }
    if (ids.length > 0) {
      log.info('question_asks.answered_by_chat_message', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        count: ids.length,
      });
    }
    return ids.length;
  } catch (error) {
    log.error('question_asks.chat_message_close_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...serializeError(error),
    });
    return 0;
  }
}

/** Whether the person wrote in the chat after the question was asked (expiry backstop). */
export function humanMessageSince(sql: SqlStorage, sessionId: string, since: number): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM chat_messages
          WHERE session_id = ? AND role = 'user' AND created_at > ?
            AND (origin IS NULL OR origin != 'system')
          LIMIT 1`,
        sessionId,
        since
      )
      .toArray().length > 0
  );
}
