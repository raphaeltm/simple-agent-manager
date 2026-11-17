/** Socket capability and append offsets are protocol constants, not runtime settings. */
export const CHAT_MESSAGE_APPEND_CAPABILITY = 'message-append-v1';

/**
 * Close code the server uses for a session socket that lacks the append capability but would
 * have been sent `message.append` (it connected while a merged batch was in flight). Any code
 * other than 1000 makes every web chat client reconnect and re-read the newest messages, which
 * returns the complete row. Application close codes must be in the 4000-4999 range.
 */
export const CHAT_MESSAGE_RESYNC_CLOSE_CODE = 4409;

/** Reporter SQLite database identity; an old Worker safely ignores this header. */
export const MESSAGE_OUTBOX_INCARNATION_HEADER = 'X-SAM-Outbox-Incarnation';

/** UTF-16 offsets match JavaScript string slicing on both Worker and browser. */
export interface ChatMessageAppend {
  id: string;
  sessionId: string;
  content: string;
  offset: number;
  revision: number;
}

/** Full canonical tool snapshots require replacement, independently of text appends. */
export const CHAT_TOOL_REPLACE_CAPABILITY = 'tool-replace-v1';

/** Revision lives in durable tool metadata, so compact/history/archive reads retain it. */
export function toolMessageRevision(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
  const revision = (metadata as Record<string, unknown>)._samToolRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0
    ? revision
    : 0;
}
