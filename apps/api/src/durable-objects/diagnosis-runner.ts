import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { ulid } from '../lib/ulid';
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
import { redactSensitiveData } from '../services/observability';

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
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return String(redactSensitiveData(raw)).slice(0, 500);
}

function classification(error: unknown): { transient: boolean; code: string } {
  const message = safeMessage(error).toLowerCase();
  if (/429|5\d\d|timeout|timed out|abort|temporar|unavailable|network/.test(message)) {
    return { transient: true, code: 'TRANSIENT_UPSTREAM' };
  }
  return { transient: false, code: 'PERMANENT_EXECUTION' };
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
    ).bind(runId).first<{ id: string; created_by: string; error_id: string | null; start_time: string; end_time: string }>();
    if (!row) throw new Error('Diagnosis run not found');
    const window = { errorId: row.error_id, startMs: Date.parse(row.start_time), endMs: Date.parse(row.end_time) };
    const state: RunnerState = {
      runId,
      createdBy: row.created_by,
      window,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Diagnose ${row.error_id ? `platform error ${row.error_id}` : 'the selected error window'} from ${row.start_time} to ${row.end_time}.` },
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
    };
    await this.ctx.storage.transaction(async tx => {
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

  async cancel(): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ? AND status IN ('queued','running')"
    ).bind(now, now, (await this.ctx.storage.get<RunnerState>('state'))?.runId ?? '').run();
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunnerState>('state');
    if (!state) return;
    const run = await this.env.DATABASE.prepare(
      'SELECT status, cancel_requested_at, deadline_at, created_at FROM debug_diagnosis_runs WHERE id = ?'
    ).bind(state.runId).first<{ status: string; cancel_requested_at: string | null; deadline_at: string | null; created_at: string }>();
    if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.status)) return;
    if (run.cancel_requested_at) return this.finish(state, 'cancelled', 'Diagnosis cancelled by an administrator', 'CANCELLED');
    if (Date.now() >= (run.deadline_at ? Date.parse(run.deadline_at) : Date.parse(run.created_at) + resolveDebugAgentConfig(this.env).hardDeadlineMs)) return this.finish(state, 'failed', 'Diagnosis exceeded its configured hard deadline', 'DEADLINE_EXCEEDED');

    const stepKey = state.currentStep === 'model'
      ? `model:${state.turns + 1}`
      : `tool:${state.turns}:${state.pendingTools[0]?.id ?? 'missing'}`;
    if (state.completedStepKeys.includes(stepKey)) {
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const started = Date.now();
    await this.heartbeat(state, stepKey);
    try {
      if (state.currentStep === 'model') await this.runModelStep(state, stepKey, started);
      else await this.runToolStep(state, stepKey, started);
    } catch (error) {
      await this.handleFailure(state, stepKey, started, error);
    }
  }

  private async runModelStep(state: RunnerState, stepKey: string, started: number): Promise<void> {
    const config = resolveDebugAgentConfig(this.env);
    if (state.turns >= config.maxTurns) throw new Error('Debugging agent reached its turn limit without a diagnosis');
    const estimate = estimatedTokens(state.messages);
    const remaining = config.runTokenLimit - state.inputTokens - state.outputTokens;
    if (remaining <= estimate) throw new Error('Per-run debugging token ceiling reached');
    const completion = await complete(this.env, config, INTERACTIVE_DEBUG_FEATURE_KEY, state.messages, Math.min(config.modelOutputTokens, remaining - estimate));
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('Debugging model returned no message');
    state.turns++;
    state.inputTokens += completion.usage?.prompt_tokens ?? estimate;
    state.outputTokens += completion.usage?.completion_tokens ?? 0;
    const tools = message.tool_calls ?? [];
    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: tools });
    state.pendingTools = tools;
    state.currentStep = tools.length ? 'tool' : 'model';
    state.attempt = 0;
    state.completedStepKeys.push(stepKey);
    await this.event(state, stepKey, 'model_turn', 'succeeded', null, null, message.content?.slice(0, 500) ?? null, Date.now() - started);
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
    await this.event(state, stepKey, 'evidence', 'succeeded', call.function.name, String(redactSensitiveData(call.function.arguments)).slice(0, 300), result.slice(0, 1000), Date.now() - started);
    await this.checkpointAndSchedule(state);
  }

  private async checkpointAndSchedule(state: RunnerState, delay = 0): Promise<void> {
    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async heartbeat(state: RunnerState, step: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET status='running', started_at=COALESCE(started_at, ?), current_step=?, heartbeat_at=?, updated_at=?, executor_version=? WHERE id=? AND status IN ('queued','running')"
    ).bind(now, step, now, now, EXECUTOR_VERSION, state.runId).run();
  }

  private async event(state: RunnerState, stepKey: string, type: string, status: string, source: string | null, args: string | null, evidence: string | null, duration: number, code: string | null = null, message: string | null = null): Promise<void> {
    state.sequence++;
    await this.env.DATABASE.prepare(
      'INSERT OR IGNORE INTO debug_diagnosis_run_events (id,run_id,sequence,step_key,event_type,status,source_name,arguments_preview,evidence_preview,duration_ms,retry_attempt,error_code,error_message,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(ulid(), state.runId, state.sequence, stepKey, type, status, source, args, evidence, duration, state.attempt, code, message, new Date().toISOString()).run();
  }

  private async handleFailure(state: RunnerState, stepKey: string, started: number, error: unknown): Promise<void> {
    const config = resolveDebugAgentConfig(this.env);
    const kind = classification(error);
    const message = safeMessage(error);
    if (kind.transient && state.attempt < config.stepMaxRetries) {
      state.attempt++;
      const delay = Math.min(config.retryMaxDelayMs, config.retryBaseDelayMs * 2 ** (state.attempt - 1));
      await this.event(state, `${stepKey}:retry:${state.attempt}`, 'retry', 'retrying', null, null, null, Date.now() - started, kind.code, message);
      await this.checkpointAndSchedule(state, delay);
      return;
    }
    await this.finish(state, 'failed', message, kind.code);
  }

  private async completeRun(state: RunnerState, diagnosis: string, model: string): Promise<void> {
    const id = ulid();
    const now = new Date().toISOString();
    const config = resolveDebugAgentConfig(this.env);
    await this.env.DATABASE.prepare(
      'INSERT INTO debug_diagnoses (id,error_id,start_time,end_time,diagnosis,model,turns,input_tokens,output_tokens,daily_tokens_used,daily_token_limit,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, state.window.errorId, new Date(state.window.startMs).toISOString(), new Date(state.window.endMs).toISOString(), diagnosis, model, state.turns, state.inputTokens, state.outputTokens, state.dailyTokensUsed, config.dailyTokenLimit, state.createdBy, now).run();
    await this.env.DATABASE.prepare(
      "UPDATE debug_diagnosis_runs SET status='succeeded',diagnosis_id=?,model=?,turns=?,input_tokens=?,output_tokens=?,daily_tokens_used=?,daily_token_limit=?,current_step='completed',heartbeat_at=?,completed_at=?,updated_at=? WHERE id=?"
    ).bind(id, model, state.turns, state.inputTokens, state.outputTokens, state.dailyTokensUsed, config.dailyTokenLimit, now, now, now, state.runId).run();
    await this.event(state, 'completed', 'completed', 'succeeded', null, null, null, 0);
    await this.ctx.storage.put('state', state);
  }

  private async finish(state: RunnerState, status: 'failed' | 'cancelled', message: string, code: string): Promise<void> {
    const now = new Date().toISOString();
    await this.event(state, `terminal:${status}`, status, status, null, null, null, 0, code, message);
    await this.env.DATABASE.prepare(
      'UPDATE debug_diagnosis_runs SET status=?,error_message=?,current_step=?,heartbeat_at=?,completed_at=?,updated_at=? WHERE id=?'
    ).bind(status, message, status, now, now, now, state.runId).run();
    await this.ctx.storage.put('state', state);
  }
}
