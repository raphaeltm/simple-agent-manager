/**
 * State-level message deduplication utility.
 *
 * All message sources (WebSocket, polling, catch-up, load-more) go through
 * this function instead of directly calling setMessages. This ensures
 * duplicates are caught at write time, not just at render time.
 *
 * @see docs/notes/2026-03-17-chat-message-duplication-report.md
 */
import { compareMessagePositions } from '@simple-agent-manager/shared';

import type { ChatMessageResponse } from './api';

export type MergeStrategy = 'replace' | 'append' | 'prepend';

/** A message the server has persisted; only those carry a sequence. */
export function isPersistedMessage(
  message: ChatMessageResponse
): message is ChatMessageResponse & { sequence: number } {
  return Number.isSafeInteger(message.sequence);
}

/**
 * Transcript order. Persisted messages follow the server's total order —
 * createdAt, then sequence, then id. An optimistic row has no sequence yet, so
 * it sorts by createdAt and then id.
 */
function compareMessages(a: ChatMessageResponse, b: ChatMessageResponse): number {
  if (isPersistedMessage(a) && isPersistedMessage(b)) return compareMessagePositions(a, b);
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Check if a message is an optimistic (client-generated) message.
 */
function isOptimistic(msg: ChatMessageResponse): boolean {
  return msg.id.startsWith('optimistic-');
}

/**
 * User-message lookups for one append merge, so reconciling an incoming message
 * costs O(1) rather than a scan of every loaded message — a refresh after a
 * long absence can append tens of thousands of rows at once.
 */
function indexUserMessages(messages: Iterable<ChatMessageResponse>) {
  const optimisticIdsByContent = new Map<string, string[]>();
  const confirmedContents = new Set<string>();
  const add = (message: ChatMessageResponse): void => {
    if (message.role !== 'user') return;
    if (!isOptimistic(message)) {
      confirmedContents.add(message.content);
      return;
    }
    const ids = optimisticIdsByContent.get(message.content);
    if (ids) ids.push(message.id);
    else optimisticIdsByContent.set(message.content, [message.id]);
  };
  for (const message of messages) add(message);
  return {
    add,
    /** Claims the oldest optimistic row with this user message's content, if any. */
    claimOptimistic: (message: ChatMessageResponse): string | undefined =>
      message.role === 'user' ? optimisticIdsByContent.get(message.content)?.shift() : undefined,
    /**
     * Whether a confirmed user message with the same content is already loaded.
     * This catches dual delivery: the DO WebSocket persists the user message
     * (message.send → message.new), then the VM agent batch-persists the same
     * content under a new ID (ExtractMessages → messages.batch).
     */
    duplicatesConfirmed: (message: ChatMessageResponse): boolean =>
      message.role === 'user' && confirmedContents.has(message.content),
  };
}

/**
 * Merge incoming messages into the existing message array, deduplicating by ID.
 *
 * Strategies:
 * - `replace`: Incoming messages are authoritative (from REST API). Replaces
 *   the full message set, but preserves optimistic messages that don't yet
 *   have a server-confirmed counterpart.
 * - `append`: Add incoming messages to the end (WebSocket real-time delivery).
 *   Skips messages whose ID already exists.
 * - `prepend`: Add incoming messages to the beginning (load-more pagination).
 *   Skips messages whose ID already exists.
 *
 * All strategies return a sorted, deduplicated array.
 */
export function mergeMessages(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[],
  strategy: MergeStrategy
): ChatMessageResponse[] {
  if (strategy === 'replace') {
    return mergeReplace(prev, incoming);
  }
  if (strategy === 'append') {
    return mergeAppend(prev, incoming);
  }
  // prepend
  return mergePrepend(prev, incoming);
}

/**
 * Replace strategy: incoming is authoritative for its time range, but
 * earlier-loaded messages (from "load more" pagination) are preserved.
 *
 * This prevents polling and WebSocket catch-up from discarding messages
 * that the user explicitly loaded via the "Load earlier messages" button.
 *
 * Note: content-based user message dedup (hasConfirmedDuplicate) is intentionally
 * NOT applied here. The REST API snapshot is the ground truth — if the server has
 * duplicate rows, they should be shown. The server-side content dedup in
 * persistMessageBatch prevents new duplicates from being created.
 */
function mergeReplace(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[]
): ChatMessageResponse[] {
  const map = new Map<string, ChatMessageResponse>();

  // Find the oldest incoming message to determine the boundary.
  // Messages older than this were loaded via pagination and should be kept.
  let oldestIncoming = Infinity;
  for (const msg of incoming) {
    if (msg.createdAt < oldestIncoming) {
      oldestIncoming = msg.createdAt;
    }
  }

  // Preserve earlier-loaded messages from prev that predate the incoming window.
  // For messages at exactly the boundary timestamp (createdAt === oldestIncoming),
  // preserve them only if their ID is not in the incoming set — this prevents
  // silent drops when the server returns only some messages at that timestamp.
  const incomingIds = new Set(incoming.map((m) => m.id));
  for (const msg of prev) {
    if (
      !isOptimistic(msg) &&
      (msg.createdAt < oldestIncoming ||
        (msg.createdAt === oldestIncoming && !incomingIds.has(msg.id)))
    ) {
      map.set(msg.id, msg);
    }
  }

  // Add all incoming messages (authoritative for the recent range)
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }

  // Preserve optimistic messages that haven't been confirmed yet
  for (const msg of prev) {
    if (isOptimistic(msg)) {
      const hasMatch = incoming.some((m) => m.role === msg.role && m.content === msg.content);
      if (!hasMatch) {
        map.set(msg.id, msg);
      }
    }
  }

  return Array.from(map.values()).sort(compareMessages);
}

/**
 * Append strategy: add incoming messages that don't already exist.
 * Also handles optimistic-to-confirmed reconciliation for user messages.
 */
function mergeAppend(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[]
): ChatMessageResponse[] {
  const map = new Map<string, ChatMessageResponse>();

  // Build map from existing messages
  for (const msg of prev) {
    map.set(msg.id, msg);
  }
  const userMessages = indexUserMessages(map.values());

  // Add incoming, skipping duplicates and reconciling optimistic messages
  for (const msg of incoming) {
    if (map.has(msg.id)) continue;

    // A server-confirmed message replaces the optimistic row it stands in for;
    // otherwise a confirmed user message already loaded under another ID wins.
    const optimisticId = userMessages.claimOptimistic(msg);
    if (optimisticId) map.delete(optimisticId);
    else if (userMessages.duplicatesConfirmed(msg)) continue;

    map.set(msg.id, msg);
    userMessages.add(msg);
  }

  return Array.from(map.values()).sort(compareMessages);
}

/**
 * Prepend strategy: add older messages that don't already exist.
 * Used by load-more pagination.
 */
function mergePrepend(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[]
): ChatMessageResponse[] {
  const map = new Map<string, ChatMessageResponse>();

  // Build map from existing messages (these take priority)
  for (const msg of prev) {
    map.set(msg.id, msg);
  }

  // Add incoming older messages, skipping duplicates
  for (const msg of incoming) {
    if (!map.has(msg.id)) {
      map.set(msg.id, msg);
    }
  }

  return Array.from(map.values()).sort(compareMessages);
}

/**
 * Get the ID of the last message in an array, or null if empty.
 * Used by autoscroll to detect genuinely new messages (vs. dedup artifacts).
 */
export function getLastMessageId(messages: ChatMessageResponse[]): string | null {
  return messages.at(-1)?.id ?? null;
}
