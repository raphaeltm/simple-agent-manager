import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { consumeFeatureTokenBudget, releaseFeatureTokenBudget } from '../services/ai-token-budget';
import {
  type ChatMessage,
  complete,
  type DebugWindow,
  estimatedTokens,
  executeTool,
  INTERACTIVE_DEBUG_FEATURE_KEY,
  resolveDebugAgentConfig,
  SYSTEM_PROMPT,
  type ToolCall,
} from '../services/debug-agent';
import {
  completeDiagnosisRunTransition,
  finishDiagnosisRunTransition,
} from '../services/diagnosis-run-transitions';
import {
  classifyDiagnosisFailure,
  diagnosisRetryDelay,
  resolveDiagnosisCompletedStepDelayMs,
  safeDiagnosisMessage,
} from '../services/diagnosis-runner-policy';
import { redactSensitiveData } from '../services/observability';
import { deferAlarmWhenDisabled } from '../services/operational-kill-switch';

const EXECUTOR_VERSION = 'diagnosis-runner-v1';

interface RunnerState {
  runId: string;
  createdBy: string;
  window: DebugWindow;
  messages: ChatMessage[];
  pendingTools: ToolCall[];
  currentStep: 'model' | 'tool';
  turns: number;
  inputTokens: number;
  outputTokens: number;
  dailyTokensUsed: number;
  sequence: number;
  attempt: number;
  completedStepKeys: string[];
  inFlightStepKey: string | null;
}

function safeMessage(error: unknown): string {
  return safeDiagnosisMessage(error);
}

/** Exported for direct unit testing — see tests/unit/durable-objects/diagnosis-runner.test.ts. */
export function resultCount(result: string): number | null {
  try {
    const parsedRaw = JSON.parse(result) as unknown;
    const value = maybeJsonRecord(parsedRaw);
    if (!value) return null;
    if (typeof value.total === 'number') return value.total;
    const arrays = Object.values(value).filter(Array.isArray);
    return arrays.length ? arrays.reduce((count, items) => count + items.length, 0) : null;
  } catch {
    return null;
  }
}

export class DiagnosisRunner extends DurableObject<Env> {
  async start(runId: string): Promise<void> {
    const existing = await this.ctx.storage.get<RunnerState>('state');
    if (existing) {
      await this.ensureStarted();
      return;
    }
    const row = await this.env.DATABASE.prepare(
      'SELECT id, created_by, error_id, start_time, end_time FROM debug_diagnosis_runs WHERE id = ?'
    )
      .bind(runId)
      .first<{
        id: string;
        created_by: string;
        error_id: string | null;
        start_time: string;
        end_time: string;
      }>();
    if (!row) throw new Error('Diagnosis run not found');
    const window = {
      errorId: row.error_id,
      startMs: Date.parse(row.start_time),
      endMs: Date.parse(row.end_time),
    };
    const state: RunnerState = {
      runId,
      createdBy: row.created_by,
      window,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Diagnose ${row.error_id ? `platform error ${row.error_id}` : 'the selected error window'} from ${row.start_time} to ${row.end_time}.`,
        },
      ],
      pendingTools: [],
      currentStep: 'model',
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      dailyTokensUsed: 0,
      sequence: 0,
      attempt: 0,
      completedStepKeys: [],
      inFlightStepKey: null,
    };
    await this.ctx.storage.transaction(async (tx) => {
      await tx.put('state', state);
      await tx.setAlarm(Date.now());
    });
  }

  async ensureStarted(): Promise<boolean> {
    const state = await this.ctx.storage.get<RunnerState>('state');
    if (!state) return false;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  async cancel(runId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ? AND run_status IN ('queued','running')"
    )
      .bind(now, now, runId)
      .run();
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    if (await deferAlarmWhenDisabled(this.env, this.ctx.storage, 'DiagnosisRunner')) return;

    const state = await this.ctx.storage.get<RunnerState>('state');
    if (!state) return;
    const run = await this.env.DATABASE.prepare(
      'SELECT run_status AS status, cancel_requested_at, deadline_at, created_at FROM debug_diagnosis_runs WHERE id = ?'
    )
      .bind(state.runId)
      .first<{
        status: string;
        cancel_requested_at: string | null;
        deadline_at: string | null;
        created_at: string;
      }>();
    if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
    if (run.cancel_requested_at)
      return this.finish(
        state,
        'cancelled',
        'Diagnosis cancelled by an administrator',
        'CANCELLED'
      );
    if (
      Date.now() >=
      (run.deadline_at
        ? Date.parse(run.deadline_at)
        : Date.parse(run.created_at) + resolveDebugAgentConfig(this.env).hardDeadlineMs)
    )
      return this.finish(
        state,
        'failed',
        'Diagnosis exceeded its configured hard deadline',
        'DEADLINE_EXCEEDED'
      );

    const stepKey =
      state.currentStep === 'model'
        ? `model:${state.turns + 1}`
        : `tool:${state.turns}:${state.pendingTools[0]?.id ?? 'missing'}`;
    if (state.completedStepKeys.includes(stepKey)) {
      const now = Date.now();
      const minimumDelayMs = resolveDiagnosisCompletedStepDelayMs(
        this.env.DIAGNOSIS_COMPLETED_STEP_MIN_DELAY_MS
      );
      await this.ctx.storage.setAlarm(Math.max(now + minimumDelayMs, now + 1));
      return;
    }
    if (state.inFlightStepKey === stepKey) {
      await this.finish(
        state,
        'failed',
        'Executor restarted while an external step outcome was ambiguous; retry this run safely',
        'AMBIGUOUS_STEP_OUTCOME'
      );
      return;
    }
    const started = Date.now();
    await this.heartbeat(state, stepKey);
    state.inFlightStepKey = stepKey;
    await this.ctx.storage.put('state', state);
    await this.event(
      state,
      `${stepKey}:started`,
      state.currentStep === 'model' ? 'model_turn' : 'evidence',
      'running',
      state.currentStep === 'tool' ? (state.pendingTools[0]?.function.name ?? null) : null,
      null,
      null,
      0
    );
    try {
      if (state.currentStep === 'model') await this.runModelStep(state, stepKey, started);
      else await this.runToolStep(state, stepKey, started);
    } catch (error) {
      await this.handleFailure(state, stepKey, started, error);
    }
  }

  private async runModelStep(state: RunnerState, stepKey: string, started: number): Promise<void> {
    const config = resolveDebugAgentConfig(this.env);
    if (state.turns >= config.maxTurns)
      throw new Error('Debugging agent reached its turn limit without a diagnosis');
    const estimate = estimatedTokens(state.messages);
    const remaining = config.runTokenLimit - state.inputTokens - state.outputTokens;
    if (remaining <= estimate) throw new Error('Per-run debugging token ceiling reached');
    const reservation = await consumeFeatureTokenBudget(
      this.env.KV,
      INTERACTIVE_DEBUG_FEATURE_KEY,
      remaining,
      config.dailyTokenLimit,
      this.env
    );
    if (!reservation.allowed) throw new Error('Daily deployment debugging budget exhausted');
    let completion;
    try {
      completion = await complete(
        this.env,
        config,
        INTERACTIVE_DEBUG_FEATURE_KEY,
        state.messages,
        Math.min(config.modelOutputTokens, remaining - estimate)
      );
    } catch (error) {
      await releaseFeatureTokenBudget(
        this.env.KV,
        INTERACTIVE_DEBUG_FEATURE_KEY,
        remaining,
        config.dailyTokenLimit,
        this.env
      );
      throw error;
    }
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('Debugging model returned no message');
    state.turns++;
    const usedOutput = completion.usage?.completion_tokens ?? 0;
    const usedInput = completion.usage?.prompt_tokens ?? estimate;
    state.inputTokens += usedInput;
    state.outputTokens += usedOutput;
    const released = await releaseFeatureTokenBudget(
      this.env.KV,
      INTERACTIVE_DEBUG_FEATURE_KEY,
      Math.max(0, remaining - usedInput - usedOutput),
      config.dailyTokenLimit,
      this.env
    );
    state.dailyTokensUsed = released.usedTokens;
    const tools = message.tool_calls ?? [];
    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: tools });
    state.pendingTools = tools;
    state.currentStep = tools.length ? 'tool' : 'model';
    state.attempt = 0;
    state.completedStepKeys.push(stepKey);
    state.inFlightStepKey = null;
    await this.event(
      state,
      stepKey,
      'model_turn',
      'succeeded',
      null,
      null,
      null,
      Date.now() - started
    );
    if (!tools.length) {
      const diagnosis = String(redactSensitiveData(message.content?.trim() ?? ''));
      if (!diagnosis) throw new Error('Debugging model returned an empty diagnosis');
      await this.completeRun(state, diagnosis, config.model);
      return;
    }
    await this.checkpointAndSchedule(state);
  }

  private async runToolStep(state: RunnerState, stepKey: string, started: number): Promise<void> {
    const call = state.pendingTools[0];
    if (!call) throw new Error('Diagnosis tool checkpoint is missing its tool call');
    const config = resolveDebugAgentConfig(this.env);
    const result = await executeTool(this.env, state.window, config, call);
    state.messages.push({ role: 'tool', content: result, tool_call_id: call.id });
    state.pendingTools.shift();
    state.currentStep = state.pendingTools.length ? 'tool' : 'model';
    state.attempt = 0;
    state.completedStepKeys.push(stepKey);
    state.inFlightStepKey = null;
    const parsed: Record<string, unknown> = (() => {
      try {
        const parsedRaw = JSON.parse(result) as unknown;
        return maybeJsonRecord(parsedRaw) ?? {};
      } catch {
        return {};
      }
    })();
    await this.event(
      state,
      stepKey,
      'evidence',
      parsed.error ? 'failed' : 'succeeded',
      call.function.name,
      String(redactSensitiveData(call.function.arguments)).slice(0, 300),
      String(redactSensitiveData(result)).slice(0, 1000),
      Date.now() - started,
      parsed.error ? 'EVIDENCE_SOURCE_UNAVAILABLE' : null,
      parsed.error ? safeMessage(parsed.cause ?? parsed.error) : null,
      resultCount(result)
    );
    await this.checkpointAndSchedule(state);
  }

  private async checkpointAndSchedule(state: RunnerState, delay = 0): Promise<void> {
    const now = new Date().toISOString();
    const config = resolveDebugAgentConfig(this.env);
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET current_step=?,heartbeat_at=?,turns=?,input_tokens=?,output_tokens=?,daily_tokens_used=?,daily_token_limit=?,attempt=?,updated_at=? WHERE id=? AND run_status IN ('queued','running')"
    )
      .bind(
        state.currentStep,
        now,
        state.turns,
        state.inputTokens,
        state.outputTokens,
        state.dailyTokensUsed,
        config.dailyTokenLimit,
        state.attempt,
        now,
        state.runId
      )
      .run();
    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async heartbeat(state: RunnerState, step: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET status='running',run_status='running',started_at=COALESCE(started_at, ?),current_step=?,heartbeat_at=?,updated_at=?,executor_version=?,attempt=? WHERE id=? AND run_status IN ('queued','running') AND cancel_requested_at IS NULL"
    )
      .bind(now, step, now, now, EXECUTOR_VERSION, state.attempt, state.runId)
      .run();
  }

  private async event(
    state: RunnerState,
    stepKey: string,
    type: string,
    status: string,
    source: string | null,
    args: string | null,
    evidence: string | null,
    duration: number,
    code: string | null = null,
    message: string | null = null,
    count: number | null = null
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      `INSERT OR IGNORE INTO debug_diagnosis_run_events
        (id,run_id,sequence,step_key,event_type,status,source_name,arguments_preview,evidence_preview,result_count,duration_ms,retry_attempt,error_code,error_message,created_at)
       SELECT ?,?,COALESCE((SELECT MAX(sequence) FROM debug_diagnosis_run_events WHERE run_id=?),0)+1,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE EXISTS (
         SELECT 1 FROM debug_diagnosis_runs
         WHERE id=? AND run_status IN ('queued','running')
           AND cancel_requested_at IS NULL
           AND (deadline_at IS NULL OR deadline_at>?)
       )`
    )
      .bind(
        ulid(),
        state.runId,
        state.runId,
        stepKey,
        type,
        status,
        source,
        args,
        evidence,
        count,
        duration,
        state.attempt,
        code,
        message,
        now,
        state.runId,
        now
      )
      .run();
    const persisted = await this.env.DATABASE.prepare(
      'SELECT sequence FROM debug_diagnosis_run_events WHERE run_id=? AND step_key=?'
    )
      .bind(state.runId, stepKey)
      .first<{ sequence: number }>();
    if (persisted) state.sequence = Math.max(state.sequence, persisted.sequence);
  }

  private async handleFailure(
    state: RunnerState,
    stepKey: string,
    started: number,
    error: unknown
  ): Promise<void> {
    const config = resolveDebugAgentConfig(this.env);
    const kind = classifyDiagnosisFailure(error);
    const message = safeMessage(error);
    if (kind.transient && state.attempt < config.stepMaxRetries) {
      state.inFlightStepKey = null;
      state.attempt++;
      const delay = diagnosisRetryDelay(
        state.attempt,
        config.retryBaseDelayMs,
        config.retryMaxDelayMs
      );
      await this.event(
        state,
        `${stepKey}:retry:${state.attempt}`,
        'retry',
        'retrying',
        null,
        null,
        null,
        Date.now() - started,
        kind.code,
        message
      );
      await this.checkpointAndSchedule(state, delay);
      return;
    }
    await this.finish(state, 'failed', message, kind.code);
  }

  private async completeRun(state: RunnerState, diagnosis: string, model: string): Promise<void> {
    const id = ulid();
    const now = new Date().toISOString();
    const config = resolveDebugAgentConfig(this.env);
    const completed = await completeDiagnosisRunTransition(this.env.DATABASE, {
      runId: state.runId,
      diagnosisId: id,
      eventId: ulid(),
      errorId: state.window.errorId,
      startTime: new Date(state.window.startMs).toISOString(),
      endTime: new Date(state.window.endMs).toISOString(),
      diagnosis,
      model,
      turns: state.turns,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      dailyTokensUsed: state.dailyTokensUsed,
      dailyTokenLimit: config.dailyTokenLimit,
      createdBy: state.createdBy,
      now,
    });
    if (!completed) await this.settleBlockedCompletion(state);
    await this.ctx.storage.put('state', state);
  }

  private async finish(
    state: RunnerState,
    status: 'failed' | 'cancelled',
    message: string,
    code: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await finishDiagnosisRunTransition(this.env.DATABASE, {
      runId: state.runId,
      eventId: ulid(),
      status,
      message,
      code,
      now,
    });
    await this.ctx.storage.put('state', state);
  }

  private async settleBlockedCompletion(state: RunnerState): Promise<void> {
    const run = await this.env.DATABASE.prepare(
      'SELECT run_status,cancel_requested_at,deadline_at,created_at FROM debug_diagnosis_runs WHERE id=?'
    )
      .bind(state.runId)
      .first<{
        run_status: string;
        cancel_requested_at: string | null;
        deadline_at: string | null;
        created_at: string;
      }>();
    if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.run_status)) return;
    if (run.cancel_requested_at) {
      await this.finish(state, 'cancelled', 'Diagnosis cancelled by an administrator', 'CANCELLED');
      return;
    }
    const deadline = run.deadline_at
      ? Date.parse(run.deadline_at)
      : Date.parse(run.created_at) + resolveDebugAgentConfig(this.env).hardDeadlineMs;
    if (Date.now() >= deadline) {
      await this.finish(
        state,
        'failed',
        'Diagnosis exceeded its configured hard deadline',
        'DEADLINE_EXCEEDED'
      );
    }
  }
}
