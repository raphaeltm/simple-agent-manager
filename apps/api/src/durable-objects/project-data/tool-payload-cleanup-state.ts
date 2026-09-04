import {
  deleteStorageSafetyMeta as deleteMeta,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
  writeStorageSafetyMeta as writeMeta,
} from './storage-safety-meta';
import type { ToolPayloadCleanupCursor } from './tool-payload-cleanup-candidates';
import type { ProjectDataToolPayloadCleanupCursor } from './tool-payload-cleanup-types';

const META_TOOL_CLEANUP_CURSOR_SESSION_ID = 'storageSafetyToolCleanupCursorSessionId';
const META_TOOL_CLEANUP_CURSOR_ROW_ID = 'storageSafetyToolCleanupCursorRowId';
const META_TOOL_CLEANUP_CURSOR_CREATED_AT = 'storageSafetyToolCleanupCursorCreatedAt';
const META_TOOL_CLEANUP_CURSOR_SEQUENCE = 'storageSafetyToolCleanupCursorSequence';
const META_TOOL_CLEANUP_CURSOR_MESSAGE_ID = 'storageSafetyToolCleanupCursorMessageId';
const META_TOOL_CLEANUP_CURSOR_VERSION = 'storageSafetyToolCleanupCursorVersion';
const META_TOOL_CLEANUP_RECHECK_AT = 'storageSafetyToolCleanupRecheckAt';
const META_TOOL_PAYLOAD_ARCHIVE_LAST_RUN_AT = 'storageSafetyToolPayloadArchiveLastRunAt';
const META_TOOL_CLEANUP_PLAN_ID = 'storageSafetyToolCleanupPlanId';
const META_TOOL_CLEANUP_PLAN_FINGERPRINT = 'storageSafetyToolCleanupPlanFingerprint';
const META_TOOL_CLEANUP_PLAN_CUTOFF = 'storageSafetyToolCleanupPlanCutoff';
const META_TOOL_CLEANUP_TOTAL_ROWS = 'storageSafetyToolCleanupTotalRows';
const META_TOOL_CLEANUP_TOTAL_BYTES = 'storageSafetyToolCleanupTotalBytes';
const META_TOOL_CLEANUP_TOTAL_R2_OPERATIONS = 'storageSafetyToolCleanupTotalR2Operations';
const META_TOOL_CLEANUP_TOTAL_WALL_TIME_MS = 'storageSafetyToolCleanupTotalWallTimeMs';
const TOOL_PAYLOAD_CLEANUP_CURSOR_VERSION = '3';

export function readProjectDataToolPayloadCleanupRecheckAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_TOOL_CLEANUP_RECHECK_AT);
}

export function readProjectDataToolPayloadArchiveLastRunAt(sql: SqlStorage): number | null {
  return readMetaNumber(sql, META_TOOL_PAYLOAD_ARCHIVE_LAST_RUN_AT);
}

export function writeProjectDataToolPayloadArchiveLastRunAt(
  sql: SqlStorage,
  lastRunAt: number
): void {
  writeMeta(sql, META_TOOL_PAYLOAD_ARCHIVE_LAST_RUN_AT, String(lastRunAt));
}

export function readToolPayloadCleanupCursor(sql: SqlStorage): ToolPayloadCleanupCursor | null {
  if (readMeta(sql, META_TOOL_CLEANUP_CURSOR_VERSION) !== TOOL_PAYLOAD_CLEANUP_CURSOR_VERSION) {
    return null;
  }
  const sessionId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  const rowId = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_ROW_ID);
  const createdAt = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  const sequence = readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  const messageId = readMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  if (
    !sessionId ||
    rowId === null ||
    rowId <= 0 ||
    createdAt === null ||
    sequence === null ||
    !messageId
  )
    return null;
  return { rowId, sessionId, createdAt, sequence, messageId };
}

export function hasCompleteLegacyV2ToolPayloadCleanupCursor(sql: SqlStorage): boolean {
  if (readMeta(sql, META_TOOL_CLEANUP_CURSOR_VERSION) !== '2') return false;
  return Boolean(
    readMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID) &&
    readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT) !== null &&
    readMetaNumber(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE) !== null &&
    readMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID)
  );
}

export type ToolPayloadCleanupPersistedPlan = {
  planId: string;
  fingerprint: string;
  cutoffCreatedAt: number;
};

export type ToolPayloadCleanupCumulativeProgress = {
  rows: number;
  bytes: number;
  r2Operations: number;
  wallTimeMs: number;
};

export function readToolPayloadCleanupCumulativeProgress(
  sql: SqlStorage
): ToolPayloadCleanupCumulativeProgress {
  return {
    rows: readMetaNumber(sql, META_TOOL_CLEANUP_TOTAL_ROWS) ?? 0,
    bytes: readMetaNumber(sql, META_TOOL_CLEANUP_TOTAL_BYTES) ?? 0,
    r2Operations: readMetaNumber(sql, META_TOOL_CLEANUP_TOTAL_R2_OPERATIONS) ?? 0,
    wallTimeMs: readMetaNumber(sql, META_TOOL_CLEANUP_TOTAL_WALL_TIME_MS) ?? 0,
  };
}

export function writeToolPayloadCleanupCumulativeProgress(
  sql: SqlStorage,
  progress: ToolPayloadCleanupCumulativeProgress
): void {
  writeMeta(sql, META_TOOL_CLEANUP_TOTAL_ROWS, String(progress.rows));
  writeMeta(sql, META_TOOL_CLEANUP_TOTAL_BYTES, String(progress.bytes));
  writeMeta(sql, META_TOOL_CLEANUP_TOTAL_R2_OPERATIONS, String(progress.r2Operations));
  writeMeta(sql, META_TOOL_CLEANUP_TOTAL_WALL_TIME_MS, String(progress.wallTimeMs));
}

export function readToolPayloadCleanupPersistedPlan(
  sql: SqlStorage
): ToolPayloadCleanupPersistedPlan | null {
  const planId = readMeta(sql, META_TOOL_CLEANUP_PLAN_ID);
  const fingerprint = readMeta(sql, META_TOOL_CLEANUP_PLAN_FINGERPRINT);
  const cutoffCreatedAt = readMetaNumber(sql, META_TOOL_CLEANUP_PLAN_CUTOFF);
  if (!planId || !fingerprint || cutoffCreatedAt === null) return null;
  return { planId, fingerprint, cutoffCreatedAt };
}

function writeToolPayloadCleanupPersistedPlan(
  sql: SqlStorage,
  plan: ToolPayloadCleanupPersistedPlan
): void {
  writeMeta(sql, META_TOOL_CLEANUP_PLAN_ID, plan.planId);
  writeMeta(sql, META_TOOL_CLEANUP_PLAN_FINGERPRINT, plan.fingerprint);
  writeMeta(sql, META_TOOL_CLEANUP_PLAN_CUTOFF, String(plan.cutoffCreatedAt));
}

export function writeToolPayloadCleanupCursor(
  sql: SqlStorage,
  cursor: ToolPayloadCleanupCursor,
  recheckAt: number,
  plan: ToolPayloadCleanupPersistedPlan
): void {
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID, cursor.sessionId);
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_ROW_ID, String(cursor.rowId));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT, String(cursor.createdAt));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE, String(cursor.sequence));
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID, cursor.messageId);
  writeMeta(sql, META_TOOL_CLEANUP_CURSOR_VERSION, TOOL_PAYLOAD_CLEANUP_CURSOR_VERSION);
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
  writeToolPayloadCleanupPersistedPlan(sql, plan);
}

export function writeToolPayloadCleanupRecheckAt(
  sql: SqlStorage,
  recheckAt: number,
  plan: ToolPayloadCleanupPersistedPlan
): void {
  writeMeta(sql, META_TOOL_CLEANUP_RECHECK_AT, String(recheckAt));
  writeToolPayloadCleanupPersistedPlan(sql, plan);
}

export function clearToolPayloadCleanupContinuationState(sql: SqlStorage): void {
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SESSION_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_ROW_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_CREATED_AT);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_SEQUENCE);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_MESSAGE_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_CURSOR_VERSION);
  deleteMeta(sql, META_TOOL_CLEANUP_RECHECK_AT);
  deleteMeta(sql, META_TOOL_CLEANUP_PLAN_ID);
  deleteMeta(sql, META_TOOL_CLEANUP_PLAN_FINGERPRINT);
  deleteMeta(sql, META_TOOL_CLEANUP_PLAN_CUTOFF);
}

export function clearToolPayloadCleanupState(sql: SqlStorage): void {
  clearToolPayloadCleanupContinuationState(sql);
  deleteMeta(sql, META_TOOL_CLEANUP_TOTAL_ROWS);
  deleteMeta(sql, META_TOOL_CLEANUP_TOTAL_BYTES);
  deleteMeta(sql, META_TOOL_CLEANUP_TOTAL_R2_OPERATIONS);
  deleteMeta(sql, META_TOOL_CLEANUP_TOTAL_WALL_TIME_MS);
}

export function publicToolPayloadCleanupCursor(
  cursor: ToolPayloadCleanupCursor | null
): ProjectDataToolPayloadCleanupCursor | null {
  if (!cursor) return null;
  return {
    rowId: cursor.rowId,
    sessionId: cursor.sessionId,
    createdAt: cursor.createdAt,
    sequence: cursor.sequence,
    messageId: cursor.messageId,
  };
}
