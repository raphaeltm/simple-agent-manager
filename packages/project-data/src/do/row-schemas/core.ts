import * as v from 'valibot';

import { log } from '@simple-agent-manager/worker-core';

// =============================================================================
// Generic parse helpers
// =============================================================================

/**
 * Parse a single row with a Valibot schema; throw a descriptive error on failure.
 */
export function parseRow<TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  row: unknown,
  context: string
): TOutput {
  const result = v.safeParse(schema, row);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const path = issue.path?.map((p) => p.key).join('.') || 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Row validation failed (${context}): ${issues}`);
  }
  return result.output;
}

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

/** Safely parse a JSON string, returning null on failure. */
export function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
