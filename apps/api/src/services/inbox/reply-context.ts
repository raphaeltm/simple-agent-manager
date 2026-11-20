/** Reuse the canonical, archive-aware transcript read; never copy a chat reply to D1/comments. */
import {
  formatMessageCursor,
  type InboxConversation,
  type TaskAttachment,
} from '@simple-agent-manager/shared';
import { log, maybeJsonRecord } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import type { Env } from '../../env';
import { getMessageCursor, getSessionMessageLimit } from '../../routes/chat-message-query';
import { TaskAttachmentSchema } from '../../schemas/tasks';
import * as projectDataService from '../project-data';

export async function readInboxConversation(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
    inboxRef: string;
    replyCursor?: string;
    responseCursor?: number;
  }
): Promise<InboxConversation> {
  const before = getMessageCursor('before', input.replyCursor);
  const anchor = input.inboxRef.startsWith('ask:') ? input.inboxRef.slice(4) : input.inboxRef;
  const [page, comments] = await Promise.all([
    projectDataService.getMessages(
      env,
      input.projectId,
      input.sessionId,
      getSessionMessageLimit(env),
      before,
      null,
      ['user'],
      false,
      'desc'
    ),
    projectDataService.listInboxItemCommentThreads(env, input.projectId, {
      itemId: anchor,
      afterSequence: input.responseCursor,
    }),
  ]);
  const replies: InboxConversation['replies'] = [];
  for (const row of page.messages) {
    try {
      const reply = parseInboxReply(row, input.inboxRef);
      if (reply) replies.push(reply);
    } catch (error) {
      log.warn('inbox.reply_row_skipped', {
        messageId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // getMessages selects newest first but returns each page in chronological order.
  // Continue before its oldest scanned row, including rows belonging to another inbox item.
  const oldest = page.messages[0];
  const nextReplyCursor =
    page.hasMore &&
    oldest &&
    typeof oldest.createdAt === 'number' &&
    typeof oldest.sequence === 'number' &&
    typeof oldest.id === 'string'
      ? formatMessageCursor({
          createdAt: oldest.createdAt,
          sequence: oldest.sequence,
          id: oldest.id,
        })
      : null;
  return {
    replies,
    responses: comments.threads.filter((t) => t.author.kind === 'agent'),
    nextReplyCursor,
    nextResponseCursor: comments.hasMore ? (comments.threads.at(-1)?.sequence ?? null) : null,
    hasMore: page.hasMore || comments.hasMore,
  };
}

function parseInboxReply(
  row: Record<string, unknown>,
  inboxRef: string
): InboxConversation['replies'][number] | null {
  const raw = row.toolMetadata;
  const metadata = maybeJsonRecord(typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw);
  if (metadata?.source !== 'inbox_reply' || metadata.inboxRef !== inboxRef) return null;
  if (
    typeof row.id !== 'string' ||
    typeof row.content !== 'string' ||
    typeof row.createdAt !== 'number'
  )
    throw new Error('Invalid inbox reply message shape');
  const attachments: TaskAttachment[] =
    metadata.attachments === undefined
      ? []
      : v.parse(v.array(TaskAttachmentSchema), metadata.attachments);
  return {
    id: row.id,
    content: row.content,
    createdAt: row.createdAt,
    userId: typeof metadata.userId === 'string' ? metadata.userId : null,
    attachments,
  };
}
