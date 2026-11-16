import { quotedName } from '@simple-agent-manager/operations';

import type { InboxErrorsPort } from '../durable-objects/project-data/ports';
import { log, serializeError } from '../lib/logger';
import { workerEnv } from './worker-env';

/** Failed chat wakes as inbox error items (slice E), filed for the ProjectData object. */
export const inboxErrorsPort: InboxErrorsPort = {
  async fileWakeFailure(projectDataEnv, input) {
    const env = workerEnv(projectDataEnv);
    try {
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
        `SELECT t.id, t.user_id, p.user_id AS project_owner_id
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ? AND t.chat_session_id = ?`
      )
        .bind(input.projectId, input.sessionId)
        .first<{ id: string; user_id: string | null; project_owner_id: string | null }>();
      if (!bound) {
        log.warn('inbox.wake_failure_unbound_chat', {
          projectId: input.projectId,
          sessionId: input.sessionId,
          action: 'marker_fallback',
        });
        return null;
      }
      // The chat's creator; for a chat with no recorded creator, the owner of the chat's own
      // task, then the project's owner. Never the owner of the task that sent the undelivered
      // message (a parent wake's sender is the child), who may not be able to open this chat.
      const owner = input.createdByUserId ?? bound.user_id ?? bound.project_owner_id;
      if (!owner) {
        log.warn('inbox.wake_failure_unaddressable', {
          projectId: input.projectId,
          sessionId: input.sessionId,
          action: 'marker_fallback',
        });
        return null;
      }
      const canWake = snapshot?.runtime !== 'cf-container';
      // Loaded on use: the filing service builds operation ports, whose graph imports this port.
      const { fileAndNotify } = await import('../services/inbox/system-errors');
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
