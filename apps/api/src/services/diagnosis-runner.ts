import type { DebugDiagnosisRunEvent } from '@simple-agent-manager/shared';

import type { DiagnosisRunner } from '../durable-objects/diagnosis-runner';
import type { Env } from '../env';
import { resolveDebugAgentConfig } from './debug-agent';

function stub(env: Env, runId: string): DurableObjectStub<DiagnosisRunner> {
  return env.DIAGNOSIS_RUNNER.get(env.DIAGNOSIS_RUNNER.idFromName(runId)) as DurableObjectStub<DiagnosisRunner>;
}

export async function startDiagnosisRunner(env: Env, runId: string): Promise<void> {
  const runner = stub(env, runId);
  try { await runner.start(runId); }
  catch (error) {
    if (!(await runner.ensureStarted())) throw error;
  }
}

export async function cancelDiagnosisRunner(env: Env, runId: string): Promise<void> {
  await stub(env, runId).cancel(runId);
}

export async function listDiagnosisEvents(env: Env, runId: string, cursor = 0, limit = 100) {
  const result = await env.DATABASE.prepare(
    'SELECT id,run_id,sequence,step_key,event_type,status,source_name,arguments_preview,evidence_preview,result_count,duration_ms,retry_attempt,error_code,error_message,created_at FROM debug_diagnosis_run_events WHERE run_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?'
  ).bind(runId, cursor, Math.min(Math.max(limit, 1), 200)).all<Record<string, unknown>>();
  const events = result.results.map(row => ({
    id: String(row.id), runId: String(row.run_id), sequence: Number(row.sequence), stepKey: String(row.step_key),
    eventType: String(row.event_type), status: String(row.status), sourceName: row.source_name as string | null,
    argumentsPreview: row.arguments_preview as string | null, evidencePreview: row.evidence_preview as string | null,
    resultCount: row.result_count as number | null, durationMs: row.duration_ms as number | null,
    retryAttempt: Number(row.retry_attempt), errorCode: row.error_code as string | null,
    errorMessage: row.error_message as string | null, createdAt: String(row.created_at),
  })) as DebugDiagnosisRunEvent[];
  return { events, nextCursor: events.at(-1)?.sequence ?? null };
}

export async function reconcileDiagnosisRuns(env: Env): Promise<{ restarted: number; terminalized: number }> {
  const config = resolveDebugAgentConfig(env);
  const now = new Date();
  const stale = new Date(now.getTime() - config.staleHeartbeatMs).toISOString();
  const rows = await env.DATABASE.prepare(
    "SELECT id,deadline_at,created_at FROM debug_diagnosis_runs WHERE status IN ('queued','running') AND (heartbeat_at IS NULL OR heartbeat_at < ?) ORDER BY created_at ASC LIMIT 50"
  ).bind(stale).all<{ id: string; deadline_at: string | null; created_at: string }>();
  let restarted = 0;
  let terminalized = 0;
  for (const row of rows.results) {
    if ((row.deadline_at ? Date.parse(row.deadline_at) : Date.parse(row.created_at) + config.hardDeadlineMs) <= now.getTime()) {
      await env.DATABASE.prepare(
        "UPDATE debug_diagnosis_runs SET status='failed',current_step='failed',error_message='Diagnosis exceeded its configured hard deadline',completed_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')"
      ).bind(now.toISOString(), now.toISOString(), row.id).run();
      terminalized++;
    } else {
      await startDiagnosisRunner(env, row.id);
      restarted++;
    }
  }
  return { restarted, terminalized };
}
