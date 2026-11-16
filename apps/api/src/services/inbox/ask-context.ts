/**
 * The transcript around an ask: the messages before it, and what the agent did since (messages
 * after it plus a count of tool runs). One implementation for the attention read
 * (`routes/chat-attention.ts`) and the inbox item read (`services/inbox/port.ts`).
 *
 * Both sides are bounded by the same admin settings: `collaboration.commentContextMessages` and
 * `collaboration.commentContextMaxRows` (the comment reader's context setting) and the Connector
 * transcript bounds. Each side is one ProjectData read.
 */
import type { InboxContextMessage, InboxItemContext } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { getSessionMessageLimit } from '../../routes/chat-message-query';
import { getCommentContextLimits } from '../collaboration-settings';
import { getConnectorReadLimits } from '../connector-read-settings';
import * as projectDataService from '../project-data';

type TranscriptPage = Awaited<ReturnType<typeof projectDataService.getLogicalTranscriptPage>>;

function toMessages(page: TranscriptPage, keep: (createdAt: number) => boolean) {
  return page.entries
    .flatMap((entry): InboxContextMessage[] =>
      entry.kind === 'message' && keep(entry.createdAt)
        ? [
            {
              id: entry.messageId,
              role: entry.role,
              content: entry.content,
              createdAt: entry.createdAt,
              truncated: entry.truncated || !entry.complete,
            },
          ]
        : []
    )
    .reverse();
}

export async function readAskContext(
  env: Env,
  input: { projectId: string; sessionId: string; askedAt: number; requestedLimit?: number }
): Promise<InboxItemContext> {
  const [context, bounds] = await Promise.all([
    getCommentContextLimits(env),
    getConnectorReadLimits(env),
  ]);
  const requested = input.requestedLimit;
  const limit = getSessionMessageLimit(
    env,
    String(
      requested !== undefined && Number.isSafeInteger(requested) && requested > 0
        ? requested
        : context.messages
    )
  );
  const request = {
    limit,
    roles: ['user', 'assistant'],
    maxScanRows: Math.min(context.maxRows, bounds.transcriptScanRows),
    maxMessageChars: bounds.transcriptMessageChars,
    maxPageChars: bounds.transcriptPageChars,
    includeLatest: false,
    includeToolTitles: false,
  };
  const [beforePage, latestPage] = await Promise.all([
    projectDataService.getLogicalTranscriptPage(env, input.projectId, input.sessionId, {
      ...request,
      before: input.askedAt,
    }),
    // Newest first from the end of the chat; only entries after the ask are kept.
    projectDataService.getLogicalTranscriptPage(env, input.projectId, input.sessionId, {
      ...request,
      before: null,
    }),
  ]);
  const after = (createdAt: number) => createdAt > input.askedAt;
  // A span that started before the ask and ran on after it (the agent asked mid tool run) still
  // shows work since asking: count at least one for it, and every tool call of a later span.
  const activityCount = latestPage.entries.reduce((count, entry) => {
    if (entry.kind !== 'activity' || !after(entry.updatedAt)) return count;
    return count + (after(entry.createdAt) ? Math.max(1, entry.toolCalls) : 1);
  }, 0);
  const oldest = latestPage.entries.at(-1);
  return {
    before: toMessages(beforePage, () => true),
    since: {
      messages: toMessages(latestPage, after),
      activityCount,
      // The newest page did not reach back to the ask: more happened than it shows.
      truncated:
        Boolean(oldest && after(oldest.createdAt)) &&
        (latestPage.hasMore || latestPage.scanBudgetExhausted),
    },
  };
}
