/** Reuse the canonical, archive-aware transcript read; never copy a chat reply to D1/comments. */
import { formatMessageCursor, type InboxConversation, type TaskAttachment } from '@simple-agent-manager/shared';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import type { Env } from '../../env';
import { getMessageCursor, getSessionMessageLimit } from '../../routes/chat-message-query';
import { TaskAttachmentSchema } from '../../schemas/tasks';
import * as projectDataService from '../project-data';

export async function readInboxConversation(env: Env, input: {
  projectId: string; sessionId: string; inboxRef: string; replyCursor?: string;
}): Promise<InboxConversation> {
  const before = getMessageCursor('before', input.replyCursor);
  const anchor = input.inboxRef.startsWith('ask:') ? input.inboxRef.slice(4) : input.inboxRef;
  const [page, comments] = await Promise.all([
    projectDataService.getMessages(env, input.projectId, input.sessionId,
      getSessionMessageLimit(env), before, null, ['user'], false, 'desc'),
    projectDataService.listInboxItemCommentThreads(env, input.projectId, { itemId: anchor }),
  ]);
  const replies: InboxConversation['replies'] = [];
  for (const row of page.messages) {
    try {
      const raw = row.toolMetadata;
      const metadata = maybeJsonRecord(typeof raw === 'string' ? JSON.parse(raw) as unknown : raw);
      if (metadata?.source !== 'inbox_reply' || metadata.inboxRef !== input.inboxRef) continue;
      if (typeof row.id !== 'string' || typeof row.content !== 'string' || typeof row.createdAt !== 'number')
        throw new Error('Invalid inbox reply message shape');
      const attachments: TaskAttachment[] = metadata.attachments === undefined ? []
        : v.parse(v.array(TaskAttachmentSchema), metadata.attachments);
      replies.push({ id: row.id, content: row.content, createdAt: row.createdAt,
        userId: typeof metadata.userId === 'string' ? metadata.userId : null, attachments });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'inbox.reply_row_skipped', messageId: row.id,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const last = page.messages.at(-1);
  const nextReplyCursor = page.hasMore && last && typeof last.createdAt === 'number' &&
    typeof last.sequence === 'number' && typeof last.id === 'string'
    ? formatMessageCursor({ createdAt: last.createdAt, sequence: last.sequence, id: last.id }) : null;
  return { replies: replies.reverse(), responses: comments.threads.filter((t) => t.author.kind === 'agent'),
    nextReplyCursor, hasMore: page.hasMore || comments.hasMore };
}
