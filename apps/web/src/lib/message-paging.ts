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
  compareMessagePositions,
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
 * The newest page of a transcript: its most recent rows in transcript order, and
 * whether older history remains. How a chat opens when nothing is cached, and
 * the window the fallback poll and reconnect catch-up compare against.
 */
export function fetchNewestPage(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<ChatSessionDetailResponse> {
  return getChatSession(projectId, sessionId, {
    signal,
    limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  });
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

function oldestPersistedMessage(
  messages: readonly ChatMessageResponse[]
): (ChatMessageResponse & { sequence: number }) | undefined {
  for (const message of messages) {
    if (isPersistedMessage(message)) return message;
  }
  return undefined;
}

function newestPersistedMessage(
  messages: readonly ChatMessageResponse[]
): (ChatMessageResponse & { sequence: number }) | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && isPersistedMessage(message)) return message;
  }
  return undefined;
}

/**
 * Merges a newest-window response into an already loaded transcript. If the
 * window no longer reaches back to the newest persisted loaded row, a plain
 * replace merge would leave a permanent hole. In that case, drain forward from
 * the loaded row and merge the complete delta instead.
 */
export async function mergeRecentWindowOrRefresh(
  projectId: string,
  sessionId: string,
  current: ChatSessionDetailResponse,
  recent: ChatSessionDetailResponse,
  signal?: AbortSignal
): Promise<ChatSessionDetailResponse> {
  const currentNewest = newestPersistedMessage(current.messages);
  const recentOldest = oldestPersistedMessage(recent.messages);
  if (currentNewest && recentOldest && compareMessagePositions(currentNewest, recentOldest) < 0) {
    const refreshed = await refreshCachedTranscript(projectId, sessionId, current, signal);
    if (refreshed) {
      return {
        ...recent,
        messages: mergeMessages(refreshed.messages, recent.messages, 'append'),
        hasMore: refreshed.hasMore,
      };
    }
  }

  return {
    ...recent,
    messages: mergeMessages(current.messages, recent.messages, 'replace'),
    hasMore: current.hasMore,
  };
}

/**
 * Where history paging should stop: at a specific message when the target names
 * one, otherwise at a point in time.
 *
 * A message id wins over the timestamp because callers do not always know the
 * message's own time — a comment jump carries the comment's creation time, which
 * is later than the message it annotates.
 */
export interface HistoryTarget {
  /** Exact message anchor, when the target is a persisted message. */
  messageId?: string | null;
  /** Point in time to reach, and to resolve the nearest message by when there is no anchor. */
  timestamp: number;
}

/** Whether `messages` already reach back to `target`. */
export function historyReaches(
  messages: readonly ChatMessageResponse[],
  target: HistoryTarget
): boolean {
  if (target.messageId) return messages.some((message) => message.id === target.messageId);
  return (messages[0]?.createdAt ?? Infinity) <= target.timestamp;
}

/**
 * Older history, read newest-first from the oldest persisted row in `loaded`,
 * until a page reaches `target` or history runs out. Returns the rows in
 * transcript order and whether older history remains. Bounded so a server that
 * never clears `hasMore` cannot spin the client.
 */
export async function fetchHistoryUntil(
  projectId: string,
  sessionId: string,
  loaded: readonly ChatMessageResponse[],
  target: HistoryTarget
): Promise<{ messages: ChatMessageResponse[]; hasMore: boolean }> {
  const older: ChatMessageResponse[] = [];
  let before = oldestPersistedCursor(loaded);
  let reached = historyReaches(loaded, target);
  let hasMore = true;
  for (let pages = 0; hasMore && before && !reached && pages < CHAT_LOAD_UNTIL_MAX_PAGES; pages++) {
    const page = await getChatSession(projectId, sessionId, {
      before,
      limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
    });
    if (page.messages.length === 0) return { messages: older, hasMore: false };
    older.unshift(...page.messages);
    reached = historyReaches(page.messages, target);
    before = oldestPersistedCursor(page.messages);
    hasMore = page.hasMore;
  }
  return { messages: older, hasMore };
}
