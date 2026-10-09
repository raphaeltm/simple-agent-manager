import type { TaskFinalAssistantMessage } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getPlatformOperationLimits } from '../operations/limits';
import { groupTokensIntoMessages, type TokenRow } from './message-groups';
import * as projectDataService from './project-data';

export type { TaskFinalAssistantMessage };

export async function getLatestAssistantMessageForTask(
  env: Env,
  projectId: string,
  sessionId: string | null
): Promise<(TaskFinalAssistantMessage & { partialBefore?: boolean; truncated?: boolean }) | null> {
  if (!sessionId) return null;

  try {
    const limits = getPlatformOperationLimits(env);
    const { messages, hasMore } = await projectDataService.getMessages(
      env,
      projectId,
      sessionId,
      limits.messageListMax,
      null,
      null,
      undefined,
      false,
      'desc'
    );
    const grouped = groupTokensIntoMessages(messages as unknown as TokenRow[]);
    const message = [...grouped].reverse().find((item) => item.role === 'assistant');
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      return null;
    }

    const CONTENT_CAP = limits.taskDetailMessageSnippetLength;
    const content =
      message.content.length > CONTENT_CAP
        ? message.content.slice(0, CONTENT_CAP) + '...'
        : message.content;

    return {
      id: typeof message.id === 'string' ? message.id : '',
      content,
      ...(hasMore && message === grouped[0] ? { partialBefore: true } : {}),
      ...(message.content.length > CONTENT_CAP ? { truncated: true } : {}),
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
