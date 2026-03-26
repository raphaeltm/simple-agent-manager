/**
 * State-level message deduplication utility.
 *
 * All message sources (WebSocket, polling, catch-up, load-more) go through
 * this function instead of directly calling setMessages. This ensures
 * duplicates are caught at write time, not just at render time.
 *
 * @see docs/notes/2026-03-17-chat-message-duplication-report.md
 */
import type { ChatMessageResponse } from './api';

export type MergeStrategy = 'replace' | 'append' | 'prepend';

/**
 * Compare function for sorting messages by createdAt, then by id for stability.
 * When sequence is available, use it as a secondary sort before id.
 */
function compareMessages(a: ChatMessageResponse, b: ChatMessageResponse): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  // Use sequence as secondary sort when both messages have it
  const aSeq = a.sequence ?? null;
  const bSeq = b.sequence ?? null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
  // Final tiebreaker: lexicographic ID comparison for deterministic order
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Check if a message is an optimistic (client-generated) message.
 */
function isOptimistic(msg: ChatMessageResponse): boolean {
  return msg.id.startsWith('optimistic-');
}

/**
 * Try to find an optimistic message in the map that matches a server-confirmed
 * message by role and content. Returns the optimistic ID if found, null otherwise.
 */
function findMatchingOptimistic(
  map: Map<string, ChatMessageResponse>,
  confirmed: ChatMessageResponse,
): string | null {
  if (confirmed.role !== 'user') return null;
  for (const [id, existing] of map) {
    if (isOptimistic(existing) && existing.role === confirmed.role && existing.content === confirmed.content) {
      return id;
    }
  }
  return null;
}

/**
 * Check if a confirmed user message with the same content already exists in
 * the map. This catches dual-delivery duplication: the DO WebSocket persists
 * the user message (message.send → message.new broadcast), then the VM agent
 * batch-persists the same content with a different ID (ExtractMessages
 * generates a new UUID → messages.batch broadcast).
 */
function hasConfirmedDuplicate(
  map: Map<string, ChatMessageResponse>,
  msg: ChatMessageResponse,
): boolean {
  if (msg.role !== 'user') return false;
  for (const existing of map.values()) {
    if (!isOptimistic(existing) && existing.role === 'user' && existing.content === msg.content) {
      return true;
    }
  }
  return false;
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
  strategy: MergeStrategy,
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
 * Replace strategy: incoming is authoritative. Build a new map from incoming,
 * then add any unconfirmed optimistic messages from prev.
 *
 * Note: content-based user message dedup (hasConfirmedDuplicate) is intentionally
 * NOT applied here. The REST API snapshot is the ground truth — if the server has
 * duplicate rows, they should be shown. The server-side content dedup in
 * persistMessageBatch prevents new duplicates from being created.
 */
function mergeReplace(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[],
): ChatMessageResponse[] {
  const map = new Map<string, ChatMessageResponse>();

  // Add all incoming messages (authoritative)
  for (const msg of incoming) {
    map.set(msg.id, msg);
  }

  // Preserve optimistic messages that haven't been confirmed yet
  for (const msg of prev) {
    if (isOptimistic(msg)) {
      const matchId = findMatchingOptimistic(map, msg);
      // If no matching confirmed message exists, keep the optimistic one
      // (Check if any incoming message matches by content)
      const hasMatch = incoming.some(
        (m) => m.role === msg.role && m.content === msg.content,
      );
      if (!hasMatch && !matchId) {
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
  incoming: ChatMessageResponse[],
): ChatMessageResponse[] {
  const map = new Map<string, ChatMessageResponse>();

  // Build map from existing messages
  for (const msg of prev) {
    map.set(msg.id, msg);
  }

  // Add incoming, skipping duplicates and reconciling optimistic messages
  for (const msg of incoming) {
    if (map.has(msg.id)) continue;

    // Check if this server-confirmed message replaces an optimistic one
    const optimisticId = findMatchingOptimistic(map, msg);
    if (optimisticId) {
      map.delete(optimisticId);
      map.set(msg.id, msg);
      continue;
    }

    // Skip confirmed user messages that duplicate existing confirmed messages
    // by content. Catches dual-delivery: DO WebSocket (message.send) persists
    // the user message, then VM agent batch also persists it with a different ID.
    if (hasConfirmedDuplicate(map, msg)) {
      continue;
    }

    map.set(msg.id, msg);
  }

  return Array.from(map.values()).sort(compareMessages);
}

/**
 * Prepend strategy: add older messages that don't already exist.
 * Used by load-more pagination.
 */
function mergePrepend(
  prev: ChatMessageResponse[],
  incoming: ChatMessageResponse[],
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
  return messages.length > 0 ? messages[messages.length - 1]!.id : null;
}
