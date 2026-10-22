/**
 * Per-project monthly budget for agent model calls, in integer micro-USD.
 *
 * A call reserves an estimate before it runs. The reservation is one conditional UPDATE whose
 * WHERE clause re-checks `spent + reserved + estimate <= limit`, so concurrent calls cannot
 * overspend the cap: D1 serializes writes and exactly the reservations that fit succeed
 * (rule 69). After the call, `settle` moves the reservation into `spent` at the computed cost.
 * A reservation whose call never settles (the Worker died) stays reserved until the month
 * rolls over; that fails safe, never towards overspending.
 */
import type { AgentModelMonthlyUsage, AgentModelUsageByModel } from '@simple-agent-manager/shared';

import { MICRO_USD_PER_USD } from './settings';

/** UTC month key, `YYYY-MM`. */
export function usageMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/** ISO start of the UTC month after `month`. */
export function monthResetsAt(month: string): string {
  const [year, monthIndex] = month.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year ?? 1970, monthIndex ?? 1, 1)).toISOString();
}

export function microUsdToUsd(microUsd: number): number {
  return Math.round(microUsd) / MICRO_USD_PER_USD;
}

interface ReserveInput {
  projectId: string;
  month: string;
  amountMicroUsd: number;
  limitMicroUsd: number;
  now: number;
}

/** True when the reservation fit under the limit and was recorded. */
export async function reserveAgentModelBudget(
  db: D1Database,
  input: ReserveInput
): Promise<boolean> {
  const amount = Math.max(1, Math.ceil(input.amountMicroUsd));
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO agent_model_monthly_usage
           (project_id, month, reserved_micro_usd, spent_micro_usd, call_count, updated_at)
         VALUES (?, ?, 0, 0, 0, ?)
         ON CONFLICT(project_id, month) DO NOTHING`
      )
      .bind(input.projectId, input.month, input.now),
    db
      .prepare(
        `UPDATE agent_model_monthly_usage
            SET reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
          WHERE project_id = ? AND month = ?
            AND spent_micro_usd + reserved_micro_usd + ? <= ?`
      )
      .bind(amount, input.now, input.projectId, input.month, amount, input.limitMicroUsd),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

interface SettleInput {
  projectId: string;
  month: string;
  modelId: string;
  reservedMicroUsd: number;
  costMicroUsd: number;
  failed: boolean;
  now: number;
}

/**
 * Release the reservation, charge the real cost, and count the call. Returns the month's totals
 * after settling. Idempotence is the caller's job: settle exactly once per reservation.
 */
export async function settleAgentModelBudget(
  db: D1Database,
  input: SettleInput
): Promise<{ spentMicroUsd: number; reservedMicroUsd: number }> {
  const reserved = Math.max(1, Math.ceil(input.reservedMicroUsd));
  const cost = Math.max(0, Math.ceil(input.costMicroUsd));
  const [totals] = await db.batch<{ spent_micro_usd: unknown; reserved_micro_usd: unknown }>([
    db
      .prepare(
        `UPDATE agent_model_monthly_usage
            SET reserved_micro_usd = MAX(reserved_micro_usd - ?, 0),
                spent_micro_usd = spent_micro_usd + ?,
                call_count = call_count + 1,
                updated_at = ?
          WHERE project_id = ? AND month = ?
          RETURNING spent_micro_usd, reserved_micro_usd`
      )
      .bind(reserved, cost, input.now, input.projectId, input.month),
    db
      .prepare(
        `INSERT INTO agent_model_usage_by_model
           (project_id, month, model_id, call_count, error_count, spent_micro_usd, last_called_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(project_id, month, model_id) DO UPDATE SET
           call_count = call_count + 1,
           error_count = error_count + excluded.error_count,
           spent_micro_usd = spent_micro_usd + excluded.spent_micro_usd,
           last_called_at = excluded.last_called_at`
      )
      .bind(input.projectId, input.month, input.modelId, input.failed ? 1 : 0, cost, input.now),
  ]);
  const row = totals?.results?.[0];
  return {
    spentMicroUsd: count(row?.spent_micro_usd),
    reservedMicroUsd: count(row?.reserved_micro_usd),
  };
}

interface TotalsRow {
  reserved_micro_usd: unknown;
  spent_micro_usd: unknown;
  call_count: unknown;
}

interface ModelRow {
  model_id: unknown;
  call_count: unknown;
  error_count: unknown;
  spent_micro_usd: unknown;
  last_called_at: unknown;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** This month's usage for the settings page, most-spent model first. */
export async function readAgentModelUsage(
  db: D1Database,
  projectId: string,
  month: string
): Promise<AgentModelMonthlyUsage> {
  const [totals, models] = await db.batch<TotalsRow | ModelRow>([
    db
      .prepare(
        `SELECT reserved_micro_usd, spent_micro_usd, call_count
           FROM agent_model_monthly_usage WHERE project_id = ? AND month = ?`
      )
      .bind(projectId, month),
    db
      .prepare(
        `SELECT model_id, call_count, error_count, spent_micro_usd, last_called_at
           FROM agent_model_usage_by_model WHERE project_id = ? AND month = ?
          ORDER BY spent_micro_usd DESC, call_count DESC, model_id ASC`
      )
      .bind(projectId, month),
  ]);
  const total = (totals?.results?.[0] ?? null) as TotalsRow | null;
  const byModel: AgentModelUsageByModel[] = [];
  for (const raw of (models?.results ?? []) as ModelRow[]) {
    if (typeof raw.model_id !== 'string') continue;
    const lastCalledAt = typeof raw.last_called_at === 'number' ? raw.last_called_at : null;
    byModel.push({
      modelId: raw.model_id,
      callCount: count(raw.call_count),
      errorCount: count(raw.error_count),
      spentUsd: microUsdToUsd(count(raw.spent_micro_usd)),
      lastCalledAt: lastCalledAt ? new Date(lastCalledAt).toISOString() : null,
    });
  }
  return {
    month,
    spentUsd: microUsdToUsd(count(total?.spent_micro_usd)),
    reservedUsd: microUsdToUsd(count(total?.reserved_micro_usd)),
    callCount: count(total?.call_count),
    resetsAt: monthResetsAt(month),
    byModel,
  };
}
