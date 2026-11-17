import type { Env } from '../../env';

const DEFAULT_CANCELLATION_PAGE_SIZE = 25;
const DEFAULT_CANCELLATION_TURN_MS = 5_000;
const DEFAULT_CANCELLATION_RETRY_PASSES = 3;
const DEFAULT_CANCELLATION_RESIDENCE_MS = 15 * 60_000;
const DEFAULT_CANCELLATION_INTERVAL_MS = 1_000;

export function cancellationConfig(env: Env) {
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    pageSize: positive(env.ORCHESTRATOR_CANCELLATION_PAGE_SIZE, DEFAULT_CANCELLATION_PAGE_SIZE),
    turnMs: positive(env.ORCHESTRATOR_CANCELLATION_TURN_MS, DEFAULT_CANCELLATION_TURN_MS),
    retryPasses: positive(
      env.ORCHESTRATOR_CANCELLATION_RETRY_PASSES,
      DEFAULT_CANCELLATION_RETRY_PASSES
    ),
    residenceMs: positive(
      env.ORCHESTRATOR_CANCELLATION_RESIDENCE_MS,
      DEFAULT_CANCELLATION_RESIDENCE_MS
    ),
    intervalMs: positive(
      env.ORCHESTRATOR_CANCELLATION_INTERVAL_MS,
      DEFAULT_CANCELLATION_INTERVAL_MS
    ),
  };
}

export function continuationDelay(sql: SqlStorage, env: Env, schedulingIntervalMs: number): number {
  return sql.exec("SELECT 1 FROM orchestrator_missions WHERE status='cancelling' LIMIT 1").toArray()
    .length
    ? cancellationConfig(env).intervalMs
    : schedulingIntervalMs;
}
