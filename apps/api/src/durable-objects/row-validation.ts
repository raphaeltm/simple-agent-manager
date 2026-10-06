/**
 * Cross-DO Durable Object SQLite row-validation helpers.
 *
 * `sql.exec(...).toArray()` on DO-embedded SQLite returns loosely-typed rows
 * with no compile-time or runtime guarantee that they match the shape a
 * caller casts them to (`as unknown as XRow[]`). A single malformed row
 * (partial write, legacy schema drift, a future migration relaxing a NOT
 * NULL constraint) must never throw the whole read — see
 * .claude/rules/50-list-read-row-fault-isolation.md.
 *
 * The throwing single-row validator (`parseRow`) already exists in
 * `project-data/row-schemas/core.ts` and is fully generic (no project-data
 * coupling). This module reuses it — matching the existing cross-DO
 * precedent in `notification-row-schemas.ts` — and adds the two
 * fault-isolated wrappers DOs outside project-data need:
 *
 *  - `mapRows`: validate a LIST of rows, skipping (and warn-logging) any row
 *    that fails validation instead of throwing the whole read.
 *  - `parseRowOrNull`: validate a SINGLE optional row (e.g. `rows[0]`),
 *    degrading to `null` + a warn log instead of throwing, for callers that
 *    already treat a missing row as null/undefined.
 *
 * It also centralizes the `conversations` / `messages` / `rate_limits` row
 * schemas that are byte-identical between the ProjectAgent and SamSession
 * DOs (see both DOs' `migrate()`). ProjectAgent's `conversations` table has
 * no `type` column at all, so `type` is optional here to cover both DOs'
 * SELECTs with one schema.
 */
import * as v from 'valibot';

import { log } from '../lib/logger';
import { parseRow } from './project-data/row-schemas';

export { parseRow };

/** Best-effort row identifier for skip-log diagnostics; `idKey` defaults to `id`. */
function bestEffortRowId(row: Record<string, unknown>, idKey: string): string | null {
  return typeof row[idKey] === 'string' ? row[idKey] : null;
}

/**
 * Map a LIST of raw DO-SQLite rows through a Valibot schema. A row that
 * fails validation is skipped and warn-logged — never thrown — so one
 * malformed row cannot 500 the whole list read. See .claude/rules/50.
 *
 * `idKey` names the row's natural best-effort identifier column for the skip
 * log (defaults to `id`; pass e.g. `'mission_id'` for tables whose primary
 * key uses a different column name).
 */
export function mapRows<TOutput>(
  rows: readonly Record<string, unknown>[],
  schema: v.GenericSchema<unknown, TOutput>,
  context: string,
  idKey: string = 'id'
): TOutput[] {
  const out: TOutput[] = [];
  let skipped = 0;

  for (const row of rows) {
    try {
      out.push(parseRow(schema, row, context));
    } catch (e) {
      skipped++;
      log.warn(`${context}_row_skipped`, { rowId: bestEffortRowId(row, idKey), error: String(e) });
    }
  }

  if (skipped > 0) {
    log.warn(`${context}_degraded`, { fetched: rows.length, returned: out.length, skipped });
  }

  return out;
}

/**
 * Parse a single optional row (e.g. `rows[0]`), degrading to `null` + a warn
 * log on validation failure instead of throwing. For hot single-row lookups
 * where the caller already treats a missing row as null/undefined (rate
 * limit bookkeeping, FTS rowid lookups, `LIMIT 1` queries).
 *
 * `idKey` names the row's natural best-effort identifier column for the skip
 * log (defaults to `id`; pass e.g. `'mission_id'` for tables whose primary
 * key uses a different column name).
 */
export function parseRowOrNull<TOutput>(
  row: Record<string, unknown> | undefined,
  schema: v.GenericSchema<unknown, TOutput>,
  context: string,
  idKey: string = 'id'
): TOutput | null {
  if (!row) return null;
  try {
    return parseRow(schema, row, context);
  } catch (e) {
    log.warn(`${context}_row_skipped`, { rowId: bestEffortRowId(row, idKey), error: String(e) });
    return null;
  }
}

// =============================================================================
// Shared row schemas — ProjectAgent + SamSession
// =============================================================================
// The `messages` and `rate_limits` tables (and their SELECTed columns) are
// byte-identical between the ProjectAgent and SamSession DOs. `conversations`
// differs only by the `type` column (SamSession has it, ProjectAgent does
// not), so `type` is optional here to validate both DOs' SELECTs.

/** `conversations` list-row shape shared by ProjectAgent and SamSession. */
export const ConversationSummaryRowSchema = v.object({
  id: v.string(),
  title: v.nullable(v.string()),
  type: v.optional(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});
export type ConversationSummaryRow = v.InferOutput<typeof ConversationSummaryRowSchema>;

/** `messages` row shape shared by ProjectAgent and SamSession. */
export const MessageRowSchema = v.object({
  id: v.string(),
  conversation_id: v.string(),
  role: v.string(),
  content: v.string(),
  tool_calls_json: v.nullable(v.string()),
  tool_call_id: v.nullable(v.string()),
  sequence: v.number(),
  created_at: v.string(),
});

/** `rate_limits` singleton-row shape shared by ProjectAgent and SamSession. */
export const RateLimitRowSchema = v.object({
  window_start: v.number(),
  request_count: v.number(),
});
export type RateLimitRow = v.InferOutput<typeof RateLimitRowSchema>;

/** `SELECT rowid FROM messages WHERE id = ?` shape, used for FTS5 sync. */
export const RowidRowSchema = v.object({
  rowid: v.number(),
});
