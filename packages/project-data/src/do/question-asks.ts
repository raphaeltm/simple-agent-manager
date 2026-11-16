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
  input: {
    projectId: string | null;
    sessionId: string;
    messageId: string | null;
    /** When the message was persisted; a question filed after it is not answered by it. */
    messageCreatedAt: number;
  },
  broadcast: Broadcast
): Promise<number> {
  if (!input.projectId) return 0;
  const now = Date.now();
  try {
    const result = await env.DATABASE.prepare(
      `UPDATE asks
          SET status = 'answered', answer_json = ?, resolved_at = ?, updated_at = ?, notified_at = ?
        WHERE project_id = ? AND source_session_id = ? AND kind = 'question' AND status = 'open'
          AND created_at <= ?
        RETURNING id`
    )
      .bind(
        JSON.stringify({ via: 'chat_message', messageId: input.messageId }),
        now,
        now,
        now,
        input.projectId,
        input.sessionId,
        input.messageCreatedAt
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

/**
 * The person wrote in the chat: the chat's system error items (a failed wake, a sleep that may
 * have lost work, an answer that never reached the agent; inbox slice E) close as recovered,
 * open or archived alike, and release their dedupe keys. Bound to the project and the chat
 * (rule 11). No agent filed them, so no notice is queued (`notified_at` set). Never throws.
 */
export async function closeChatErrorAsksForHumanMessage(
  env: Env,
  input: { projectId: string | null; sessionId: string }
): Promise<number> {
  if (!input.projectId) return 0;
  const now = Date.now();
  try {
    const result = await env.DATABASE.prepare(
      `UPDATE asks
          SET status = CASE WHEN status = 'open' THEN 'done' ELSE status END,
              answer_json = CASE WHEN status = 'open' THEN '{"resolution":"recovered"}' ELSE answer_json END,
              resolved_at = CASE WHEN status = 'open' THEN ? ELSE resolved_at END,
              notified_at = COALESCE(notified_at, ?), dedupe_key = NULL, updated_at = ?
        WHERE project_id = ? AND kind = 'error' AND status IN ('open', 'archived')
          AND dedupe_key IN (?, ?, ?)`
    )
      .bind(
        now,
        now,
        now,
        input.projectId,
        `error:wake:${input.sessionId}`,
        `error:sleep:${input.sessionId}`,
        `error:delivery:${input.sessionId}`
      )
      .run();
    return result.meta?.changes ?? 0;
  } catch (error) {
    log.error('chat_error_asks.close_failed', {
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
