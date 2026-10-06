import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Materialization row schemas
// =============================================================================

/**
 * Session indexing state for an incremental materialization pass.
 *
 * The watermark columns arrived in DO migration 057; rows written before it —
 * and rows rehomed by an archive migration, which copies `materialized_at` but
 * not the watermark — read back NULL. `resolveWatermark()` in
 * `../materialization.ts` folds that case back to `materialized_at`.
 */
const MaterializationStateSchema = v.object({
  status: v.string(),
  materialized_at: v.nullable(v.number()),
  search_index_state: v.nullable(v.string()),
  materialized_through_created_at: v.nullable(v.number()),
  materialized_through_sequence: v.nullable(v.number()),
});

export interface MaterializationState {
  status: string;
  materializedAt: number | null;
  searchIndexState: string | null;
  throughCreatedAt: number | null;
  throughSequence: number | null;
}

export function parseMaterializationState(row: unknown): MaterializationState {
  const r = parseRow(MaterializationStateSchema, row, 'materialization_state');
  return {
    status: r.status,
    materializedAt: r.materialized_at,
    searchIndexState: r.search_index_state,
    throughCreatedAt: r.materialized_through_created_at,
    throughSequence: r.materialized_through_sequence,
  };
}

/** Raw message token for materialization grouping */
const MaterializationTokenSchema = v.object({
  id: v.string(),
  role: v.string(),
  content: v.string(),
  created_at: v.number(),
  // Backfilled from rowid by DO migration 007, but nullable in the schema, so a
  // legacy row must not fail the whole pass.
  sequence: v.nullable(v.number()),
});

export function parseMaterializationToken(row: unknown): {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  sequence: number;
} {
  const r = parseRow(MaterializationTokenSchema, row, 'materialization_token');
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    sequence: r.sequence ?? 0,
  };
}

/** Trailing grouped row for a session, used to extend a run across a pass boundary. */
const TrailingGroupSchema = v.object({
  rowid: v.number(),
  role: v.string(),
  content: v.string(),
});

export function parseTrailingGroup(row: unknown): {
  rowid: number;
  role: string;
  content: string;
} {
  const r = parseRow(TrailingGroupSchema, row, 'materialization_trailing_group');
  return { rowid: r.rowid, role: r.role, content: r.content };
}

/** Grouped message rowid lookup */
const RowidSchema = v.object({ rowid: v.number() });

export function parseRowid(row: unknown, context: string): number {
  return parseRow(RowidSchema, row, context).rowid;
}

/** Session ID-only row for batch materialization */
const SessionIdSchema = v.object({ id: v.string() });

export function parseSessionId(row: unknown, context: string): string {
  return parseRow(SessionIdSchema, row, context).id;
}
