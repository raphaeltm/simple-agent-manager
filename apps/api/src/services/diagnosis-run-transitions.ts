import type { DebugDiagnosisRunStatus } from '@simple-agent-manager/shared';

export interface CompleteDiagnosisRunInput {
  runId: string;
  diagnosisId: string;
  eventId: string;
  errorId: string | null;
  startTime: string;
  endTime: string;
  diagnosis: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  dailyTokensUsed: number;
  dailyTokenLimit: number;
  createdBy: string;
  now: string;
}

export interface FinishDiagnosisRunInput {
  runId: string;
  eventId: string;
  status: Extract<DebugDiagnosisRunStatus, 'failed' | 'cancelled'>;
  message: string;
  code: string;
  now: string;
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return Number(result?.meta?.changes ?? 0) > 0;
}

/**
 * Atomically publishes a diagnosis only while its run is still active, not
 * cancelled, and before its deadline. A late external completion therefore
 * cannot create an orphan diagnosis or overwrite a terminal run.
 */
export async function completeDiagnosisRunTransition(
  db: D1Database,
  input: CompleteDiagnosisRunInput
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO debug_diagnoses
          (id,error_id,start_time,end_time,diagnosis,model,turns,input_tokens,output_tokens,daily_tokens_used,daily_token_limit,created_by,created_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (
           SELECT 1 FROM debug_diagnosis_runs
           WHERE id=? AND run_status IN ('queued','running')
             AND cancel_requested_at IS NULL
             AND (deadline_at IS NULL OR deadline_at>?)
         )`
      )
      .bind(
        input.diagnosisId,
        input.errorId,
        input.startTime,
        input.endTime,
        input.diagnosis,
        input.model,
        input.turns,
        input.inputTokens,
        input.outputTokens,
        input.dailyTokensUsed,
        input.dailyTokenLimit,
        input.createdBy,
        input.now,
        input.runId,
        input.now
      ),
    db
      .prepare(
        `UPDATE debug_diagnosis_runs
         SET status='succeeded',run_status='succeeded',diagnosis_id=?,model=?,turns=?,input_tokens=?,output_tokens=?,daily_tokens_used=?,daily_token_limit=?,current_step='completed',heartbeat_at=?,completed_at=?,updated_at=?
         WHERE id=? AND run_status IN ('queued','running')
           AND cancel_requested_at IS NULL
           AND (deadline_at IS NULL OR deadline_at>?)`
      )
      .bind(
        input.diagnosisId,
        input.model,
        input.turns,
        input.inputTokens,
        input.outputTokens,
        input.dailyTokensUsed,
        input.dailyTokenLimit,
        input.now,
        input.now,
        input.now,
        input.runId,
        input.now
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO debug_diagnosis_run_events
          (id,run_id,sequence,step_key,event_type,status,retry_attempt,created_at)
         SELECT ?,?,COALESCE((SELECT MAX(sequence) FROM debug_diagnosis_run_events WHERE run_id=?),0)+1,
                'completed','completed','succeeded',0,?
         WHERE EXISTS (
           SELECT 1 FROM debug_diagnosis_runs
           WHERE id=? AND run_status='succeeded' AND diagnosis_id=?
         )`
      )
      .bind(input.eventId, input.runId, input.runId, input.now, input.runId, input.diagnosisId),
  ]);

  return changed(results[1]);
}

/** Atomically wins a failed/cancelled terminal transition and its event. */
export async function finishDiagnosisRunTransition(
  db: D1Database,
  input: FinishDiagnosisRunInput
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE debug_diagnosis_runs
         SET status='failed',run_status=?,error_message=?,current_step=?,heartbeat_at=?,completed_at=?,updated_at=?
         WHERE id=? AND run_status IN ('queued','running')
           AND ((?='cancelled' AND cancel_requested_at IS NOT NULL)
             OR (?='failed' AND cancel_requested_at IS NULL))`
      )
      .bind(
        input.status,
        input.message,
        input.status,
        input.now,
        input.now,
        input.now,
        input.runId,
        input.status,
        input.status
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO debug_diagnosis_run_events
          (id,run_id,sequence,step_key,event_type,status,retry_attempt,error_code,error_message,created_at)
         SELECT ?,?,COALESCE((SELECT MAX(sequence) FROM debug_diagnosis_run_events WHERE run_id=?),0)+1,
                ?,?,?,0,?,?,?
         WHERE EXISTS (
           SELECT 1 FROM debug_diagnosis_runs WHERE id=? AND run_status=?
         )`
      )
      .bind(
        input.eventId,
        input.runId,
        input.runId,
        `terminal:${input.status}`,
        input.status,
        input.status,
        input.code,
        input.message,
        input.now,
        input.runId,
        input.status
      ),
  ]);

  return changed(results[0]);
}
