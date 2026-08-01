import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import * as projectDataService from './project-data';

const log = createModuleLogger('task_final_assistant_message');

export interface TaskFinalAssistantMessage {
  id: string;
  content: string;
  createdAt: number | string;
}

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
      ['assistant'],
      false,
      'desc'
    );
    const message = messages[0];
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      return null;
    }

    return {
      id: typeof message.id === 'string' ? message.id : '',
      content: message.content,
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
