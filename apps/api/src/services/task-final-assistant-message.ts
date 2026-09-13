import type { TaskFinalAssistantMessage } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';

export type { TaskFinalAssistantMessage };

/**
 * Assistant rows read from the tail of the session to find its final turn.
 *
 * This cannot be 1. A turn is persisted as one row per VM-agent flush, so the
 * newest single row is the last ~2 seconds of text — historically, with one row
 * per streamed token, it was frequently a single character. The read path folds
 * contiguous rows of one turn back into a single message, but it can only fold
 * rows that were fetched, so the window has to span the turn.
 *
 * Override with TASK_FINAL_ASSISTANT_MESSAGE_SCAN_ROWS.
 */
export const DEFAULT_TASK_FINAL_ASSISTANT_MESSAGE_SCAN_ROWS = 200;

/** Characters of the final turn surfaced on a task. */
export const DEFAULT_TASK_FINAL_ASSISTANT_MESSAGE_MAX_CHARS = 2000;

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getLatestAssistantMessageForTask(
  env: Env,
  projectId: string,
  sessionId: string | null
): Promise<TaskFinalAssistantMessage | null> {
  if (!sessionId) return null;

  try {
    const scanRows = resolvePositiveInt(
      env.TASK_FINAL_ASSISTANT_MESSAGE_SCAN_ROWS,
      DEFAULT_TASK_FINAL_ASSISTANT_MESSAGE_SCAN_ROWS
    );
    const { messages } = await projectDataService.getMessages(
      env,
      projectId,
      sessionId,
      scanRows,
      null,
      null,
      ['assistant'],
      false,
      'desc'
    );
    // `getMessages` returns chronologically ascending for both orders, so the
    // newest turn is last.
    const message = messages[messages.length - 1];
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      return null;
    }

    const contentCap = resolvePositiveInt(
      env.TASK_FINAL_ASSISTANT_MESSAGE_MAX_CHARS,
      DEFAULT_TASK_FINAL_ASSISTANT_MESSAGE_MAX_CHARS
    );
    const content =
      message.content.length > contentCap
        ? message.content.slice(0, contentCap) + '...'
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
