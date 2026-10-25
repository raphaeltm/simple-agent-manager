import type { TaskFinalAssistantMessage } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getPlatformOperationLimits } from '../operations/limits';
import { getConnectorReadLimits } from './connector-read-settings';
import * as projectDataService from './project-data';

export type { TaskFinalAssistantMessage };

/**
 * The newest assistant reply in a chat, assembled from its streamed chunks inside the object that
 * owns the transcript (`durable-objects/project-data/logical-transcript.ts`). The scan is bounded by
 * `connector.transcriptScanRows`; a reply whose start lies beyond it is marked `partialBefore`,
 * and a chat whose newest reply lies beyond it returns null rather than an older reply.
 */
export async function getLatestAssistantMessageForTask(
  env: Env,
  projectId: string,
  sessionId: string | null
): Promise<(TaskFinalAssistantMessage & { partialBefore?: boolean; truncated?: boolean }) | null> {
  if (!sessionId) return null;

  try {
    const cap = getPlatformOperationLimits(env).taskDetailMessageSnippetLength;
    const scan = await getConnectorReadLimits(env);
    const page = await projectDataService.getLogicalTranscriptPage(env, projectId, sessionId, {
      before: null,
      limit: 1,
      roles: ['assistant'],
      maxScanRows: scan.transcriptScanRows,
      // One extra character tells a reply of exactly `cap` characters from a longer one.
      maxMessageChars: cap + 1,
      maxPageChars: cap + 1,
      includeLatest: false,
      includeToolTitles: false,
    });
    const message = page.entries.find((entry) => entry.kind === 'message');
    if (!message || message.kind !== 'message' || !message.content.trim()) return null;

    const truncated = message.contentLength > cap;
    return {
      id: message.messageId,
      content: truncated ? message.content.slice(0, cap) + '...' : message.content,
      ...(message.complete ? {} : { partialBefore: true }),
      ...(truncated ? { truncated: true } : {}),
      createdAt: message.createdAt,
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
