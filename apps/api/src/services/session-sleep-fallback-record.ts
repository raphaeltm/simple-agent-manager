/** Stored fallback metadata shared by the sweep and cleanup ownership guards. */
import * as v from 'valibot';

const RecoveryPointSchema = v.object({
  generation: v.string(),
  commit: v.string(),
  branch: v.nullable(v.string()),
  detached: v.boolean(),
  upstream: v.nullable(v.string()),
  capturedAt: v.nullable(v.string()),
  snapshotStatus: v.string(),
  degradation: v.string(),
  workingTreeSaved: v.boolean(),
  homeSaved: v.boolean(),
});

const FallbackRecordSchema = v.object({
  version: v.literal(1),
  outcome: v.picklist(['slept', 'blocked']),
  trigger: v.picklist(['attempt_budget', 'elapsed_budget', 'retry_ceiling']),
  blockedReason: v.nullable(
    v.picklist([
      'teardown_unconfirmed',
      'runtime_changed',
      'no_git_baseline',
      'commit_objects_unavailable',
      'recovery_point_expired',
      'unsupported_runtime',
      'retry_ceiling',
    ])
  ),
  decidedAt: v.string(),
  episodeStartedAt: v.nullable(v.string()),
  failedAttempts: v.number(),
  lastError: v.nullable(v.string()),
  recoveryPoint: v.nullable(RecoveryPointSchema),
});

export type SessionSleepRecoveryPoint = v.InferOutput<typeof RecoveryPointSchema>;
export type SessionSleepFallbackRecord = v.InferOutput<typeof FallbackRecordSchema>;

/**
 * Read a stored fallback record. A malformed value is treated as absent rather than
 * thrown: it is diagnostic metadata, and a wake or a purge must not fail on it.
 */
export function parseSessionSleepFallbackRecord(
  value: string | null | undefined
): SessionSleepFallbackRecord | null {
  if (!value) return null;
  try {
    const parsed = v.safeParse(FallbackRecordSchema, JSON.parse(value) as unknown);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export function serializeSessionSleepFallbackRecord(record: SessionSleepFallbackRecord): string {
  return JSON.stringify(v.parse(FallbackRecordSchema, record));
}

const REARMABLE_REASONS = [
  'no_git_baseline',
  'commit_objects_unavailable',
  'recovery_point_expired',
  'unsupported_runtime',
  'retry_ceiling',
  'teardown_unconfirmed',
] as const;

export function isRearmableSessionSleepBlock(value: string | null | undefined): boolean {
  const record = parseSessionSleepFallbackRecord(value);
  return (
    record?.outcome === 'blocked' &&
    REARMABLE_REASONS.some((reason) => reason === record.blockedReason)
  );
}

/** Static alias only; malformed metadata must not block unrelated cleanup forever. */
export function rearmableSessionSleepBlockSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid sleep block SQL alias');
  const j = `${alias}.sleep_fallback_json`;
  const field = (name: string) => `json_extract(${j}, '$.${name}')`;
  const type = (name: string) => `json_type(${j}, '$.${name}')`;
  return `COALESCE(CASE WHEN json_valid(${j}) THEN (
    ${type('version')} IN ('integer', 'real') AND ${field('version')} = 1 AND ${field('outcome')} = 'blocked'
    AND ${field('blockedReason')} IN (${REARMABLE_REASONS.map((reason) => `'${reason}'`).join(', ')})
    AND ${field('trigger')} IN ('attempt_budget', 'elapsed_budget', 'retry_ceiling')
    AND ${type('decidedAt')} = 'text'
    AND ${type('episodeStartedAt')} IN ('text', 'null')
    AND ${type('failedAttempts')} IN ('integer', 'real')
    AND ${type('lastError')} IN ('text', 'null')
    AND (${type('recoveryPoint')} = 'null' OR (
      ${type('recoveryPoint')} = 'object'
      AND ${type('recoveryPoint.generation')} = 'text'
      AND ${type('recoveryPoint.commit')} = 'text'
      AND ${type('recoveryPoint.branch')} IN ('text', 'null')
      AND ${type('recoveryPoint.detached')} IN ('true', 'false')
      AND ${type('recoveryPoint.upstream')} IN ('text', 'null')
      AND ${type('recoveryPoint.capturedAt')} IN ('text', 'null')
      AND ${type('recoveryPoint.snapshotStatus')} = 'text'
      AND ${type('recoveryPoint.degradation')} = 'text'
      AND ${type('recoveryPoint.workingTreeSaved')} IN ('true', 'false')
      AND ${type('recoveryPoint.homeSaved')} IN ('true', 'false')
    ))
  ) ELSE 0 END, 0)`;
}
