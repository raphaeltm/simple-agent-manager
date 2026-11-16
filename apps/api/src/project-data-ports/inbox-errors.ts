import { quotedName } from '@simple-agent-manager/operations';

import type { InboxErrorsPort } from '../durable-objects/project-data/ports';
import { log, serializeError } from '../lib/logger';
import { fileAndNotify } from '../services/inbox/system-errors';
import { workerEnv } from './worker-env';

/** Failed chat wakes as inbox error items (slice E), filed for the ProjectData object. */
export const inboxErrorsPort: InboxErrorsPort = {
  async fileWakeFailure(projectDataEnv, input) {
    const env = workerEnv(projectDataEnv);
    try {
      // The chat's creator; for a chat with no recorded creator, its task's owner, then the
      // project's owner (the person a task's chat belongs to).
      const owner =
        input.createdByUserId ??
        (
          await env.DATABASE.prepare(
            `SELECT COALESCE(
                (SELECT t.user_id FROM tasks t WHERE t.id = ? AND t.project_id = p.id),
                p.user_id) AS user_id
               FROM projects p WHERE p.id = ?`
          )
            .bind(input.taskId, input.projectId)
            .first<{ user_id: string | null }>()
        )?.user_id ??
        null;
      if (!owner) {
        log.warn('inbox.wake_failure_unaddressable', {
          projectId: input.projectId,
          sessionId: input.sessionId,
        });
        return null;
      }
      // `ensureSessionRecovery` wakes VM chats; an Instant chat wakes when it gets a message, so
      // offering Wake there would be a button that always refuses.
      const snapshot = await env.DATABASE.prepare(
        'SELECT runtime FROM session_snapshots WHERE chat_session_id = ? AND project_id = ?'
      )
        .bind(input.sessionId, input.projectId)
        .first<{ runtime: string | null }>();
      // The chat's own task, not the task that sent the undelivered message (a parent wake's
      // sender is the child). Without one the item cannot be tied to the chat, so the
      // ProjectData object keeps its own marker instead (`wake-failure.ts`).
      const bound = await env.DATABASE.prepare(
        'SELECT id FROM tasks WHERE project_id = ? AND chat_session_id = ?'
      )
        .bind(input.projectId, input.sessionId)
        .first<{ id: string }>();
      if (!bound) return null;
      const canWake = snapshot?.runtime !== 'cf-container';
      return await fileAndNotify(env, {
        projectId: input.projectId,
        assigneeUserId: owner,
        source: 'wake',
        subjectId: input.sessionId,
        title: `Couldn't wake ${quotedName(input.topic, 'a chat')}`,
        body: 'SAM could not restart the agent for this chat, so the message waiting for it was not delivered.',
        actions: canWake ? ['wake', 'open_chat'] : ['open_chat'],
        sourceTaskId: bound.id,
        sourceSessionId: input.sessionId,
        links: [{ kind: 'chat', id: input.sessionId, label: null }],
      });
    } catch (error) {
      log.error('inbox.wake_failure_file_failed', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        ...serializeError(error),
      });
      return null;
    }
  },
};
