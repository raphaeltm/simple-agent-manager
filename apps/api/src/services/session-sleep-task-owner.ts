import { and, eq, isNull, or, type SQL } from 'drizzle-orm';

import * as schema from '../db/schema';

type ChatSessionIdColumn =
  typeof schema.sessionSnapshots.chatSessionId | typeof schema.workspaces.chatSessionId;

/**
 * Join conditions resolving the task that owns a chat session, the way the
 * session-sleep lifecycle resolves it: the ProjectData summary's task first, then
 * — only for a summary that names no task — the legacy `tasks.chat_session_id`
 * link. `tasks.chat_session_id` is uniquely indexed, so at most one task matches.
 *
 * `sleepWorkspaceSession`, `checkAutomaticSessionSleepEligibility`, the sleep
 * lifecycle repair sweep and failed-task preservation all act on this owner, so
 * they must resolve the same task (`.claude/rules/58`, `.claude/rules/67`).
 *
 * Usage: `.leftJoin(schema.sessionSummaries, owner.summary).leftJoin(schema.tasks, owner.task)`.
 */
export function chatSessionTaskOwnerJoins(chatSessionId: ChatSessionIdColumn): {
  summary: SQL;
  task: SQL | undefined;
} {
  return {
    summary: eq(schema.sessionSummaries.id, chatSessionId),
    task: or(
      eq(schema.tasks.id, schema.sessionSummaries.taskId),
      and(isNull(schema.sessionSummaries.taskId), eq(schema.tasks.chatSessionId, chatSessionId))
    ),
  };
}
