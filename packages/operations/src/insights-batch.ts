/**
 * The read pattern every Insights tab shares: its aggregate statements go to D1 in one `batch()`
 * round trip, and if the batch fails as a whole each statement is retried on its own so one bad
 * section cannot blank the page. Rows read back are a trust boundary: each is validated, and a
 * malformed one costs only itself (`.claude/rules/50`).
 */
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import type { FlowStatement } from './insights-flow-sql';
import type { OperationContext } from './types';

export type InsightsRows = Record<string, unknown>[];

/**
 * Run `statements` as one batch. On a whole-batch failure each statement runs alone; one that
 * still fails is left out of the result and reported through `onSectionFailed`. `event` names
 * the log events (`<event>.batch_failed`).
 */
export async function runInsightsBatch<K extends string>(
  ctx: OperationContext,
  event: string,
  projectId: string,
  statements: Record<K, FlowStatement>,
  onSectionFailed: (key: K, error: unknown) => void
): Promise<Partial<Record<K, InsightsRows>>> {
  const keys = Object.keys(statements) as K[];
  const prepared = keys.map((key) =>
    ctx.env.DATABASE.prepare(statements[key].sql).bind(...statements[key].binds)
  );
  try {
    const results = await ctx.env.DATABASE.batch(prepared);
    return Object.fromEntries(keys.map((key, i) => [key, results[i]?.results ?? []])) as Partial<
      Record<K, InsightsRows>
    >;
  } catch (error) {
    log.error(`${event}.batch_failed`, {
      projectId,
      error: error instanceof Error ? error.message : String(error),
      action: 'retrying_statements_individually',
    });
  }
  const settled = await Promise.all(
    keys.map(async (key, i): Promise<[K, InsightsRows | undefined]> => {
      const statement = prepared[i];
      if (!statement) return [key, undefined];
      try {
        const result = await statement.all();
        return [key, result.results ?? []];
      } catch (error) {
        onSectionFailed(key, error);
        return [key, undefined];
      }
    })
  );
  return Object.fromEntries(settled.filter(([, value]) => value !== undefined)) as Partial<
    Record<K, InsightsRows>
  >;
}

/**
 * Validate rows one by one; a row that fails is logged as `<event>.row_skipped` with its id
 * (`idField`, when the row has one) and dropped.
 */
export function parseInsightsRows<S extends v.GenericSchema>(
  rows: InsightsRows | undefined,
  schema: S,
  event: string,
  context: string,
  projectId: string,
  idField?: string
): v.InferOutput<S>[] {
  const out: v.InferOutput<S>[] = [];
  for (const raw of rows ?? []) {
    const parsed = v.safeParse(schema, raw);
    if (parsed.success) out.push(parsed.output);
    else {
      const rowId = idField && typeof raw[idField] === 'string' ? raw[idField] : null;
      log.error(`${event}.row_skipped`, {
        projectId,
        context,
        ...(idField ? { rowId } : {}),
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
    }
  }
  return out;
}
