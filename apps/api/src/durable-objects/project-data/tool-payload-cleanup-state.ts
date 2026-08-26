import {
  deleteStorageSafetyMeta as deleteMeta,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import type { ToolPayloadCleanupCursor } from './tool-payload-cleanup-candidates';
import type { ProjectDataToolPayloadCleanupCursor } from './tool-payload-cleanup-types';

const META_TOOL_CLEANUP_CURSOR_SESSION_ID = 'storageSafetyToolCleanupCursorSessionId';
const META_TOOL_CLEANUP_CURSOR_CREATED_AT = 'storageSafetyToolCleanupCursorCreatedAt';
const META_TOOL_CLEANUP_CURSOR_SEQUENCE = 'storageSafetyToolCleanupCursorSequence';
const META_TOOL_CLEANUP_CURSOR_MESSAGE_ID = 'storageSafetyToolCleanupCursorMessageId';
const META_TOOL_CLEANUP_RECHECK_AT = 'storageSafetyToolCleanupRecheckAt';
const TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID = '__session_exhausted__';

export function readProjectDataToolPayloadCleanupRecheckAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

export function readToolPayloadCleanupCursor(sql: SqlStorage): ToolPayloadCleanupCursor | null {
  const sessionId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  const createdAt = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  const sequence = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  const messageId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  if (!sessionId || createdAt === null || sequence === null || !messageId) return null;
  return { sessionId, createdAt, sequence, messageId };
}

export function writeToolPayloadCleanupCursor(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor,
  recheckAt: number
): void {
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID, cursor.sessionId);
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT, String(cursor.createdAt));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE, String(cursor.sequence));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID, cursor.messageId);
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
}

export function writeToolPayloadCleanupRecheckAt(sql: SqlStorage, recheckAt: number): void {
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
}

export function clearToolPayloadCleanupState(sql: SqlStorage): void {
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

export function isSessionExhaustedCursor(cursor: ToolPayloadCleanupCursor): boolean {
  return (
    cursor.createdAt === Number.MAX_SAFE_INTEGER &&
    cursor.sequence === Number.MAX_SAFE_INTEGER &&
    cursor.messageId === TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID
  );
}

export function buildSessionExhaustedCursor(sessionId: string): ToolPayloadCleanupCursor {
  return {
    sessionId,
    createdAt: Number.MAX_SAFE_INTEGER,
    sequence: Number.MAX_SAFE_INTEGER,
    messageId: TOOL_PAYLOAD_SESSION_EXHAUSTED_MESSAGE_ID,
  };
}

export function publicToolPayloadCleanupCursor(
  cursor: ToolPayloadCleanupCursor | null
): ProjectDataToolPayloadCleanupCursor | null {
  if (!cursor) return null;
  return {
    sessionId: cursor.sessionId,
    createdAt: cursor.createdAt,
    sequence: cursor.sequence,
    messageId: cursor.messageId,
  };
}

export function selectNextTerminalSessionId(
  sql: SqlStorage,
  cutoffUpdatedAt: number,
  afterSessionId: string
): string | null {
  const cursor = sql
    .exec(
      `SELECT id
       FROM chat_sessions
       WHERE status IN ('stopped', 'failed')
         AND updated_at <= ?
         AND id > ?
       ORDER BY id ASC
       LIMIT 1`,
      cutoffUpdatedAt,
      afterSessionId
    )
    .raw();

  let sessionId: string | null = null;
  for (const row of cursor) {
    const id = row[0];
    if (typeof id === 'string') sessionId = id;
  }
  return sessionId;
}
