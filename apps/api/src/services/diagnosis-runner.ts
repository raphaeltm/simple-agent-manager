import type { DebugDiagnosisRunEvent } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { DiagnosisRunner } from '../durable-objects/diagnosis-runner';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { resolveDebugAgentConfig } from './debug-agent';
import { finishDiagnosisRunTransition } from './diagnosis-run-transitions';

// D1 row shape for debug_diagnosis_run_events, validated before the
// String()/Number() normalization below runs. Text columns can legitimately
// be TEXT or (rarely, if ever stored numerically) NUMERIC in SQLite, so the
// "id-like" fields accept string|number; the counters must be actual
// numbers — a mistyped counter previously coerced to NaN via bare `Number()`
// and could poison the `nextCursor` pagination cursor for the rest of the
// run's event history. A row that fails this shape is skipped (rule 50 list
// fault isolation) rather than silently returned as a corrupt event.
const idLikeSchema = v.union([v.string(), v.number()]);
const nullableIdLikeSchema = v.nullable(idLikeSchema);
const debugDiagnosisRunEventRowSchema = v.object({
  id: idLikeSchema,
  run_id: idLikeSchema,
  sequence: v.number(),
  step_key: idLikeSchema,
  event_type: idLikeSchema,
  status: idLikeSchema,
  source_name: nullableIdLikeSchema,
  arguments_preview: nullableIdLikeSchema,
  evidence_preview: nullableIdLikeSchema,
  result_count: v.nullable(v.number()),
  duration_ms: v.nullable(v.number()),
  retry_attempt: v.number(),
  error_code: nullableIdLikeSchema,
  error_message: nullableIdLikeSchema,
  created_at: idLikeSchema,
});

function stub(env: Env, runId: string): DurableObjectStub<DiagnosisRunner> {
  return env.DIAGNOSIS_RUNNER.get(
    env.DIAGNOSIS_RUNNER.idFromName(runId)
  ) as DurableObjectStub<DiagnosisRunner>;
}

export async function startDiagnosisRunner(env: Env, runId: string): Promise<void> {
  const runner = stub(env, runId);
  try {
    await runner.start(runId);
  } catch (error) {
    if (!(await runner.ensureStarted())) throw error;
  }
}

export async function cancelDiagnosisRunner(env: Env, runId: string): Promise<void> {
  await stub(env, runId).cancel(runId);
}

export async function listDiagnosisEvents(env: Env, runId: string, cursor = 0, limit = 100) {
  const pageSize = Math.min(Math.max(limit, 1), 200);
  const result = await env.DATABASE.prepare(
    'SELECT id,run_id,sequence,step_key,event_type,status,source_name,arguments_preview,evidence_preview,result_count,duration_ms,retry_attempt,error_code,error_message,created_at FROM debug_diagnosis_run_events WHERE run_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?'
  )
    .bind(runId, cursor, pageSize + 1)
    .all<Record<string, unknown>>();
  const hasMore = result.results.length > pageSize;
  const events: DebugDiagnosisRunEvent[] = [];
  for (const row of result.results.slice(0, pageSize)) {
    const parsed = v.safeParse(debugDiagnosisRunEventRowSchema, row);
    if (!parsed.success) {
      const rowId = typeof row.id === 'string' || typeof row.id === 'number' ? row.id : null;
      log.warn('diagnosis_runner.event_row_skipped', { runId, rowId });
      continue;
    }
    const r = parsed.output;
    events.push({
      id: String(r.id),
      runId: String(r.run_id),
      sequence: r.sequence,
      stepKey: String(r.step_key),
      eventType: String(r.event_type),
      status: String(r.status),
      sourceName: r.source_name === null ? null : String(r.source_name),
      argumentsPreview: r.arguments_preview === null ? null : String(r.arguments_preview),
      evidencePreview: r.evidence_preview === null ? null : String(r.evidence_preview),
      resultCount: r.result_count,
      durationMs: r.duration_ms,
      retryAttempt: r.retry_attempt,
      errorCode: r.error_code === null ? null : String(r.error_code),
      errorMessage: r.error_message === null ? null : String(r.error_message),
      createdAt: String(r.created_at),
    });
  }
  return { events, nextCursor: hasMore ? (events.at(-1)?.sequence ?? null) : null };
}

export async function reconcileDiagnosisRuns(
  env: Env
): Promise<{ restarted: number; terminalized: number }> {
  const config = resolveDebugAgentConfig(env);
  const now = new Date();
  const stale = new Date(now.getTime() - config.staleHeartbeatMs).toISOString();
  const rows = await env.DATABASE.prepare(
    "SELECT id,deadline_at,created_at FROM debug_diagnosis_runs WHERE run_status IN ('queued','running') AND (heartbeat_at IS NULL OR heartbeat_at < ?) ORDER BY created_at ASC LIMIT 50"
  )
    .bind(stale)
    .all<{ id: string; deadline_at: string | null; created_at: string }>();
  let restarted = 0;
  let terminalized = 0;
  for (const row of rows.results) {
    if (
      (row.deadline_at
        ? Date.parse(row.deadline_at)
        : Date.parse(row.created_at) + config.hardDeadlineMs) <= now.getTime()
    ) {
      const finished = await finishDiagnosisRunTransition(env.DATABASE, {
        runId: row.id,
        eventId: ulid(),
        status: 'failed',
        message: 'Diagnosis exceeded its configured hard deadline',
        code: 'DEADLINE_EXCEEDED',
        now: now.toISOString(),
      });
      if (finished) terminalized++;
    } else {
      await startDiagnosisRunner(env, row.id);
      restarted++;
    }
  }
  return { restarted, terminalized };
}
