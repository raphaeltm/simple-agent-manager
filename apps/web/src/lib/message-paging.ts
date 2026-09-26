/**
 * Paging over a session's persisted transcript.
 *
 * Every page is bounded by an exact `[createdAt,sequence,id]` cursor taken from
 * a message the server persisted, so a boundary inside a group of tied
 * timestamps resumes exactly where it stopped. Optimistic rows the client shows
 * before the server echoes them carry no `sequence` and a client-clock
 * `createdAt`; they never bound a page, or the server would skip whatever it
 * persisted "before" that local time.
 */
import {
  DEFAULT_CHAT_DELTA_MAX_PAGES,
  DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES,
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  formatMessageCursor,
} from '@simple-agent-manager/shared';

import { type ChatMessageResponse, type ChatSessionDetailResponse, getChatSession } from './api';
import { isPersistedMessage, mergeMessages } from './merge-messages';

const CHAT_DELTA_MAX_PAGES =
  Number.parseInt(import.meta.env.VITE_CHAT_DELTA_MAX_PAGES || '', 10) ||
  DEFAULT_CHAT_DELTA_MAX_PAGES;
const CHAT_LOAD_UNTIL_MAX_PAGES =
  Number.parseInt(import.meta.env.VITE_CHAT_LOAD_UNTIL_MAX_PAGES || '', 10) ||
  DEFAULT_CHAT_LOAD_UNTIL_MAX_PAGES;

/** Cursor for the newest persisted message in `messages`, if one is loaded. */
export function newestPersistedCursor(
  messages: readonly ChatMessageResponse[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const cursor = message && persistedCursor(message);
    if (cursor) return cursor;
  }
  return undefined;
}

/** Cursor for the oldest persisted message in `messages`, if one is loaded. */
export function oldestPersistedCursor(
  messages: readonly ChatMessageResponse[]
): string | undefined {
  for (const message of messages) {
    const cursor = persistedCursor(message);
    if (cursor) return cursor;
  }
  return undefined;
}

function persistedCursor(message: ChatMessageResponse): string | undefined {
  return isPersistedMessage(message) ? formatMessageCursor(message) : undefined;
}

/**
 * Brings a cached transcript up to date by reading every message persisted
 * after its newest persisted row, oldest-first, until the server has nothing
 * newer. Returns null when the cache holds no persisted row to resume from.
 *
 * Throws rather than returning a partial range: a cache that stopped halfway
 * would anchor the next refresh past the rows it never read.
 */
export async function refreshCachedTranscript(
  projectId: string,
  sessionId: string,
  cached: ChatSessionDetailResponse,
  signal?: AbortSignal
): Promise<ChatSessionDetailResponse | null> {
  let after = newestPersistedCursor(cached.messages);
  if (!after) return null;
  let page = await getChatSession(projectId, sessionId, { signal, after });
  const newer = [...page.messages];
  for (let pages = 1; page.hasMore; pages++) {
    const next = newestPersistedCursor(page.messages);
    if (pages >= CHAT_DELTA_MAX_PAGES || !next || next === after) {
      throw new Error(`Message refresh for session ${sessionId} stopped after ${pages} pages`);
    }
    after = next;
    page = await getChatSession(projectId, sessionId, { signal, after });
    newer.push(...page.messages);
  }
  return {
    ...page,
    messages: mergeMessages(cached.messages, newer, 'append'),
    // The refresh read forward to the newest row; `hasMore` still describes older history.
    hasMore: cached.hasMore,
  };
}

/**
 * Older history, read newest-first from the oldest persisted row in `loaded`,
 * until a page reaches back to `untilCreatedAt` or history runs out. Returns
 * the rows in transcript order and whether older history remains. Bounded so a
 * server that never clears `hasMore` cannot spin the client.
 */
export async function fetchHistoryUntil(
  projectId: string,
  sessionId: string,
  loaded: readonly ChatMessageResponse[],
  untilCreatedAt: number
): Promise<{ messages: ChatMessageResponse[]; hasMore: boolean }> {
  const older: ChatMessageResponse[] = [];
  let before = oldestPersistedCursor(loaded);
  let oldest = loaded[0]?.createdAt ?? Infinity;
  let hasMore = true;
  for (
    let pages = 0;
    hasMore && before && oldest > untilCreatedAt && pages < CHAT_LOAD_UNTIL_MAX_PAGES;
    pages++
  ) {
    const page = await getChatSession(projectId, sessionId, {
      before,
      limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
    });
    const first = page.messages[0];
    if (!first) return { messages: older, hasMore: false };
    older.unshift(...page.messages);
    oldest = first.createdAt;
    before = oldestPersistedCursor(page.messages);
    hasMore = page.hasMore;
  }
  return { messages: older, hasMore };
}
