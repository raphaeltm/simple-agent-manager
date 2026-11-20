import type {
  InboxConversation,
  InboxItem,
  InboxItemCommentThread,
  InboxReplyMessage,
} from '@simple-agent-manager/shared';

import type { InboxConversationCursor } from '../../lib/api';
import { formatAge } from './inbox-model';

/**
 * Pure model of an inbox item as a conversation (idea 01M7N16AF5HDPH1ZND4D4RJ00J): the ask is
 * the agent's first message, then the person's replies (canonical chat messages) and the agent's
 * responses (comment threads anchored on the item), in time order.
 */

/**
 * One turn after the ask. An agent response is a comment thread anchored on the item; its
 * follow-ups are turns of their own, placed by their own time (a follow-up can come long after
 * later turns). `response` is the agent's text; `comment` is a person's comment in a thread.
 */
export type InboxConversationEntry =
  | { kind: 'reply'; id: string; at: number; reply: InboxReplyMessage }
  | { kind: 'response'; id: string; at: number; body: string }
  | { kind: 'comment'; id: string; at: number; body: string; name: string | null };

function threadEntries(thread: InboxItemCommentThread): InboxConversationEntry[] {
  const out: InboxConversationEntry[] = [];
  if (typeof thread?.id !== 'string' || typeof thread.createdAt !== 'number') return out;
  out.push({ kind: 'response', id: thread.id, at: thread.createdAt, body: thread.body ?? '' });
  for (const followUp of thread.replies ?? []) {
    if (typeof followUp?.id !== 'string' || typeof followUp.createdAt !== 'number') continue;
    const id = `${thread.id}/${followUp.id}`;
    out.push(
      followUp.author?.kind === 'agent'
        ? { kind: 'response', id, at: followUp.createdAt, body: followUp.body ?? '' }
        : {
            kind: 'comment',
            id,
            at: followUp.createdAt,
            body: followUp.body ?? '',
            name: followUp.author?.name?.trim() || null,
          }
    );
  }
  return out;
}

/**
 * Merge every page read so far. Reply pages walk back through earlier chat history and response
 * pages walk forward, so a later page can hold either older or newer turns: entries are
 * de-duplicated by id and sorted by time (id breaks ties so the order is stable).
 */
export function conversationEntries(
  pages: ReadonlyArray<InboxConversation | null | undefined>
): InboxConversationEntry[] {
  const byId = new Map<string, InboxConversationEntry>();
  for (const page of pages) {
    if (!page) continue;
    for (const reply of page.replies ?? []) {
      if (typeof reply?.id !== 'string' || typeof reply.createdAt !== 'number') continue;
      byId.set(`reply:${reply.id}`, { kind: 'reply', id: reply.id, at: reply.createdAt, reply });
    }
    for (const thread of page.responses ?? []) {
      for (const entry of threadEntries(thread)) byId.set(`${entry.kind}:${entry.id}`, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Where to continue after `page`, or null when neither stream has more. Only streams with a
 * cursor advance: the server would restart a stream whose cursor is omitted alongside the other.
 */
export function nextConversationCursor(
  page: InboxConversation | null | undefined
): InboxConversationCursor | null {
  if (!page) return null;
  const cursor: InboxConversationCursor = {};
  if (page.nextReplyCursor) cursor.replyCursor = page.nextReplyCursor;
  if (typeof page.nextResponseCursor === 'number') cursor.responseCursor = page.nextResponseCursor;
  return cursor.replyCursor !== undefined || cursor.responseCursor !== undefined ? cursor : null;
}

/** The id of the newest agent turn, which carries the answer controls; null keeps them on the ask. */
export function latestResponseId(entries: InboxConversationEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'response') return entry.id;
  }
  return null;
}

/**
 * The person's text without the file list the chat appends for the agent
 * (`buildVisibleInitialPrompt`): the inbox shows attachments as chips instead.
 */
const ATTACHED_FILES_MARKER = '\n\n## Attached Files\n';
export function replyDisplayText(reply: InboxReplyMessage): string {
  // The chat appends its section last, so the last marker is the generated one; the person's
  // own text may contain the same heading.
  const cut = reply.attachments.length > 0 ? reply.content.lastIndexOf(ATTACHED_FILES_MARKER) : -1;
  return (cut >= 0 ? reply.content.slice(0, cut) : reply.content).trim();
}

/** "You" for the viewer, the person's name, else "A teammate". */
export function replierName(
  reply: { userId: string | null; name?: string | null },
  viewerId: string
): string {
  if (reply.userId && reply.userId === viewerId) return 'You';
  return reply.name?.trim() || 'A teammate';
}

/** What a list row says about the item's conversation, or null when nobody has replied. */
export interface InboxRowReplyHint {
  /** True when the agent acted after the reply and the item came back. */
  fresh: boolean;
  text: string;
}

export function rowReplyHint(
  item: InboxItem,
  viewerId: string,
  now: number
): InboxRowReplyHint | null {
  const latest = item.latestReply;
  if (!latest) return null;
  const who = replierName(latest, viewerId);
  const age = formatAge(latest.repliedAt, now);
  // Back from the agent: it responded or changed the ask after the reply. A closed item (the
  // agent resolved it) is not fresh news, and neither is one still with the agent.
  if (!item.withAgent && item.canReply === true)
    return { fresh: true, text: `The agent responded · ${who} replied ${age} ago` };
  return { fresh: false, text: `${who} replied ${age} ago` };
}
