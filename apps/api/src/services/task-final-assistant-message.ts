import type { TaskFinalAssistantMessage } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

export type { TaskFinalAssistantMessage };

export async function getLatestAssistantMessageForTask(
  env: Env,
  projectId: string,
  sessionId: string | null
): Promise<TaskFinalAssistantMessage | null> {
  if (!sessionId) return null;

  try {
    const { messages } = await projectDataService.getMessages(
      env,
      projectId,
      sessionId,
      1,
      null,
      null,
      ['assistant'],
      false,
      'desc'
    );
    const message = messages[0];
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      return null;
    }

    const CONTENT_CAP = 2000;
    const content = message.content.length > CONTENT_CAP
      ? message.content.slice(0, CONTENT_CAP) + '...'
      : message.content;

    return {
      id: typeof message.id === 'string' ? message.id : '',
      content,
      createdAt:
        typeof message.createdAt === 'number' || typeof message.createdAt === 'string'
          ? message.createdAt
          : '',
    };
  } catch (err) {
    log.warn('get_latest_assistant_message_for_task_failed', {
      projectId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
