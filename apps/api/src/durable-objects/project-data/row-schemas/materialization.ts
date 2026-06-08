import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Materialization row schemas
// =============================================================================

/** Session materialization check: materialized_at, status */
const MaterializationCheckSchema = v.object({
  materialized_at: v.nullable(v.number()),
  status: v.string(),
});

export function parseMaterializationCheck(row: unknown): {
  materializedAt: number | null;
  status: string;
} {
  const r = parseRow(MaterializationCheckSchema, row, 'materialization_check');
  return { materializedAt: r.materialized_at, status: r.status };
}

/** Raw message token for materialization grouping */
const MaterializationTokenSchema = v.object({
  id: v.string(),
  role: v.string(),
  content: v.string(),
  created_at: v.number(),
});

export function parseMaterializationToken(row: unknown): {
  id: string;
  role: string;
  content: string;
  createdAt: number;
} {
  const r = parseRow(MaterializationTokenSchema, row, 'materialization_token');
  return { id: r.id, role: r.role, content: r.content, createdAt: r.created_at };
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
