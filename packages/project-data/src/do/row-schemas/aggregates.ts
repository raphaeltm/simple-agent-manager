import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Aggregate / utility row schemas
// =============================================================================

/** COUNT(*) as cnt */
const CountCntRowSchema = v.object({ cnt: v.number() });

export function parseCountCnt(row: unknown, context: string): number {
  return parseRow(CountCntRowSchema, row, context).cnt;
}

/** COUNT(*) as count */
const CountRowSchema = v.object({ count: v.number() });

export function parseCount(row: unknown, context: string): number {
  return parseRow(CountRowSchema, row, context).count;
}

/** MAX(sequence) / MAX(something) as max_seq */
const MaxSeqRowSchema = v.object({ max_seq: v.number() });

export function parseMaxSeq(row: unknown, context: string): number {
  return parseRow(MaxSeqRowSchema, row, context).max_seq;
}

/** MIN(something) as earliest — nullable aggregate */
const MinEarliestRowSchema = v.object({ earliest: v.nullable(v.number()) });

export function parseMinEarliest(row: unknown, context: string): number | null {
  return parseRow(MinEarliestRowSchema, row, context).earliest;
}

/** MAX(created_at) as latest — nullable aggregate (used in index.ts) */
const MaxLatestRowSchema = v.object({ latest: v.nullable(v.number()) });

export function parseMaxLatest(row: unknown, context: string): number | null {
  return parseRow(MaxLatestRowSchema, row, context).latest;
}

/** Single-column message_count read */
const MessageCountRowSchema = v.object({ message_count: v.number() });

export function parseMessageCount(row: unknown, context: string): number {
  return parseRow(MessageCountRowSchema, row, context).message_count;
}

/** Single-column workspace_id nullable read */
const WorkspaceIdRowSchema = v.object({ workspace_id: v.nullable(v.string()) });

export function parseWorkspaceId(row: unknown, context: string): string | null {
  return parseRow(WorkspaceIdRowSchema, row, context).workspace_id;
}

/** Single-column enabled boolean (stored as 0/1 integer) */
const EnabledRowSchema = v.object({ enabled: v.number() });

export function parseEnabled(row: unknown, context: string): boolean {
  return parseRow(EnabledRowSchema, row, context).enabled === 1;
}

/** Single-column cleanup_at read */
const CleanupAtRowSchema = v.object({ cleanup_at: v.number() });

export function parseCleanupAt(row: unknown, context: string): number {
  return parseRow(CleanupAtRowSchema, row, context).cleanup_at;
}
