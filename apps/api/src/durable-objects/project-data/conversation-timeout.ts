import { createModuleLogger, serializeError } from '../../lib/logger';
import * as idleCleanup from './idle-cleanup';
import type { Env } from './types';

const log = createModuleLogger('project_data');

export async function stopTimedOutConversationWorkspaces(
  env: Env,
  timedOut: Array<{ sessionId: string; workspaceId: string | null }>
): Promise<void> {
  const workspaceEntries = timedOut.filter(
    (entry): entry is { sessionId: string; workspaceId: string } => entry.workspaceId !== null
  );
  await Promise.allSettled(
    workspaceEntries.map(async (entry) => {
      try {
        const taskRow = env.DATABASE
          ? await env.DATABASE.prepare(
              `SELECT task_mode FROM tasks
               WHERE workspace_id = ? AND status IN ('in_progress', 'delegated') LIMIT 1`
            )
              .bind(entry.workspaceId)
              .first<{ task_mode: string | null }>()
          : null;
        if (taskRow?.task_mode !== 'conversation') return;

        await idleCleanup.stopWorkspaceInD1(env.DATABASE, entry.workspaceId);
        log.info('acp_session.conversation_workspace_stopped', {
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
          reason: 'heartbeat_timeout_coupled_stop',
        });
      } catch (err) {
        log.error('acp_session.conversation_workspace_stop_failed', {
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
          ...serializeError(err),
        });
      }
    })
  );
}
