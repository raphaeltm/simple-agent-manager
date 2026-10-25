import type { TaskFinalAssistantMessage } from '@simple-agent-manager/shared';

import type { LogicalMessage } from '../durable-objects/project-data/logical-transcript-model';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getPlatformOperationLimits } from '../operations/limits';
import { getConnectorReadLimits } from './connector-read-settings';
import * as projectDataService from './project-data';

export type { TaskFinalAssistantMessage };

export type TaskAssistantMessage = TaskFinalAssistantMessage & {
  partialBefore?: boolean;
  truncated?: boolean;
};

function toTaskAssistantMessage(message: LogicalMessage, cap: number): TaskAssistantMessage {
  const truncated = message.contentLength > cap;
  return {
    id: message.messageId,
    content: truncated ? message.content.slice(0, cap) + '...' : message.content,
    ...(message.complete ? {} : { partialBefore: true }),
    ...(truncated ? { truncated: true } : {}),
    createdAt: message.createdAt,
  };
}

/**
 * The newest `count` assistant replies in a chat, newest first (a reply with no text is left
 * out), each assembled from its streamed
 * chunks inside the object that owns the transcript
 * (`durable-objects/project-data/logical-transcript.ts`) and capped at
 * `taskDetailMessageSnippetLength`. The scan is bounded by `connector.transcriptScanRows`: a reply
 * whose start lies beyond it is marked `partialBefore`, and replies beyond it are not returned.
 * Returns an empty list when the transcript cannot be read.
 */
export async function getRecentAssistantMessagesForTask(
  env: Env,
  projectId: string,
  sessionId: string | null,
  count: number
): Promise<TaskAssistantMessage[]> {
  if (!sessionId || count < 1) return [];

  try {
    const cap = getPlatformOperationLimits(env).taskDetailMessageSnippetLength;
    const scan = await getConnectorReadLimits(env);
    const page = await projectDataService.getLogicalTranscriptPage(env, projectId, sessionId, {
      before: null,
      limit: count,
      roles: ['assistant'],
      maxScanRows: scan.transcriptScanRows,
      // `contentLength` is the whole reply's length, so a capped read still says it was cut.
      maxMessageChars: cap,
      maxPageChars: cap * count,
      includeLatest: false,
      includeToolTitles: false,
    });
    return page.entries.flatMap((entry) =>
      entry.kind === 'message' && entry.content.trim() ? [toTaskAssistantMessage(entry, cap)] : []
    );
  } catch (err) {
    log.warn('get_recent_assistant_messages_for_task_failed', {
      projectId,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * The newest assistant reply with text in a chat, or null. Reads the same recent replies as the
 * task view (`operations/task-core.ts`), so both report the same final message.
 */
export async function getLatestAssistantMessageForTask(
  env: Env,
  projectId: string,
  sessionId: string | null
): Promise<TaskAssistantMessage | null> {
  const count = getPlatformOperationLimits(env).taskDetailRecentMessageLimit;
  const [latest] = await getRecentAssistantMessagesForTask(env, projectId, sessionId, count);
  return latest ?? null;
}
