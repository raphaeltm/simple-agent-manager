/**
 * Pure helpers for `useChatWebSocket`: turning transcript frames into messages, and fencing a
 * catch-up snapshot against live changes that arrived while it was being read.
 */
import type { ChatMessageAppend } from '@simple-agent-manager/shared';

import type { ChatMessageResponse } from '../lib/api';
import { maybeJsonRecord } from '../lib/runtime-validation';

/** The default activity predicate: every row but the user's own. */
export function isNonUserMessage(msg: ChatMessageResponse): boolean {
  return msg.role !== 'user';
}

/** A `message.new` payload as a message, or null when it carries no content. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire payload, as before
export function parseMessageNewFrame(p: any): ChatMessageResponse | null {
  // Only deliver if content is present (broadcast now includes it)
  if (!p.content) return null;
  return {
    id: p.messageId || p.id || crypto.randomUUID(),
    sessionId: p.sessionId,
    role: p.role,
    content: p.content,
    toolMetadata: p.toolMetadata || null,
    createdAt: p.createdAt || Date.now(),
    sequence: p.sequence ?? null,
  };
}

/** A well-formed `message.append` payload, or null: its revision must be its end offset. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire payload, as before
export function parseMessageAppendFrame(payload: any, sessionId: string): ChatMessageAppend | null {
  if (
    typeof payload.id !== 'string' ||
    typeof payload.content !== 'string' ||
    !Number.isSafeInteger(payload.offset) ||
    !Number.isSafeInteger(payload.revision) ||
    payload.offset < 0 ||
    payload.revision !== payload.offset + payload.content.length
  )
    return null;
  return {
    id: payload.id,
    sessionId,
    content: payload.content,
    offset: payload.offset,
    revision: payload.revision,
  };
}

/** The rows of a `messages.batch` payload that carry content. */
export function parseMessagesBatchFrame(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire payload, as before
  p: any,
  sessionId: string
): ChatMessageResponse[] {
  return (p.messages ?? [])
    .filter((m: Record<string, unknown>) => m.content)
    .map((m: Record<string, unknown>) => ({
      id: (m.id as string) || crypto.randomUUID(),
      sessionId,
      role: (m.role as string) || 'assistant',
      content: m.content as string,
      toolMetadata: maybeJsonRecord(m.toolMetadata),
      createdAt: (m.createdAt as number) || Date.now(),
      sequence: (m.sequence as number) ?? null,
    }));
}

/**
 * Capture the live-change generations now. The returned check reports whether a field (or,
 * without one, every field) is unchanged since, and whether the same socket is still current.
 */
export function snapshotFence(
  generations: Record<string, number>,
  isSocketCurrent: () => boolean
): (field?: string) => boolean {
  const captured = { ...generations };
  return (field?: string) =>
    isSocketCurrent() &&
    (field
      ? (generations[field] ?? 0) === (captured[field] ?? 0)
      : Object.keys(generations).every((key) => (generations[key] ?? 0) === (captured[key] ?? 0)));
}
