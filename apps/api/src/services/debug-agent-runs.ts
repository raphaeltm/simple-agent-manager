import {
  type DebugAgentUsage,
  type DebugDiagnosis,
  type DebugDiagnosisRun,
} from '@simple-agent-manager/shared';
import { and, desc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import {
  consumeFeatureTokenBudget,
  getFeatureTokenBudget,
  releaseFeatureTokenBudget,
} from './ai-token-budget';
import {
  type ChatMessage,
  type Completion,
  INTERACTIVE_DEBUG_FEATURE_KEY,
  resolveDebugAgentConfig,
  type SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY,
  SYSTEM_PROMPT,
} from './debug-agent-common';
import { complete, estimatedTokens, executeTool, resolveWindow } from './debug-agent-tools';
import { getDiagnosticIncidentByErrorId } from './diagnostic-incidents';
import { redactSensitiveData } from './observability';

export function toDiagnosis(row: typeof schema.debugDiagnoses.$inferSelect): DebugDiagnosis {
  const usage: DebugAgentUsage = {
    turns: row.turns,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.inputTokens + row.outputTokens,
    dailyTokensUsed: row.dailyTokensUsed,
    dailyTokenLimit: row.dailyTokenLimit,
  };
  return { ...row, usage };
}

export function toDiagnosisRun(
  row: typeof schema.debugDiagnosisRuns.$inferSelect,
  diagnosis?: DebugDiagnosis | null
): DebugDiagnosisRun {
  const { legacyStatus, ...publicRow } = row;
  void legacyStatus;
  const usage: DebugAgentUsage = {
    turns: row.turns,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.inputTokens + row.outputTokens,
    dailyTokensUsed: row.dailyTokensUsed,
    dailyTokenLimit: row.dailyTokenLimit,
  };
  return { ...publicRow, usage, diagnosis };
}

export async function createDebugDiagnosisRun(
  env: Env,
  createdBy: string,
  input: { errorId?: string; startTime?: string; endTime?: string },
  retryOfRunId?: string | null
): Promise<DebugDiagnosisRun> {
  const config = resolveDebugAgentConfig(env);
  const window = await resolveWindow(env, input, config);
  const db = drizzle(env.DATABASE, { schema });
  const id = ulid();
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.parse(now) + config.hardDeadlineMs).toISOString();
  await db.insert(schema.debugDiagnosisRuns).values({
    id,
    legacyStatus: 'queued',
    status: 'queued',
    errorId: window.errorId,
    startTime: new Date(window.startMs).toISOString(),
    endTime: new Date(window.endMs).toISOString(),
    retryOfRunId: retryOfRunId ?? null,
    currentStep: 'queued',
    heartbeatAt: now,
    deadlineAt,
    executorVersion: 'diagnosis-runner-v1',
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  const row = await db
    .select()
    .from(schema.debugDiagnosisRuns)
    .where(eq(schema.debugDiagnosisRuns.id, id))
    .get();
  if (!row) throw new Error('Failed to persist debugging diagnosis run');
  return toDiagnosisRun(row, null);
}

export async function retryDebugDiagnosisRun(
  env: Env,
  runId: string,
  createdBy: string
): Promise<DebugDiagnosisRun> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select()
    .from(schema.debugDiagnosisRuns)
    .where(eq(schema.debugDiagnosisRuns.id, runId))
    .get();
  if (!row) throw new Error('Diagnosis run not found');
  if (!['failed', 'cancelled'].includes(row.status))
    throw new Error('Only failed or cancelled diagnosis runs can be retried');
  const existing = await env.DATABASE.prepare(
    "SELECT id FROM debug_diagnosis_runs WHERE retry_of_run_id=? AND created_by=? AND run_status IN ('queued','running','succeeded') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(runId, createdBy)
    .first<{ id: string }>();
  if (existing) {
    const existingRow = await db
      .select()
      .from(schema.debugDiagnosisRuns)
      .where(eq(schema.debugDiagnosisRuns.id, existing.id))
      .get();
    if (existingRow) return toDiagnosisRun(existingRow, null);
  }
  return createDebugDiagnosisRun(
    env,
    createdBy,
    row.errorId ? { errorId: row.errorId } : { startTime: row.startTime, endTime: row.endTime },
    row.id
  );
}

export async function runDebugDiagnosis(
  env: Env,
  createdBy: string,
  input: { errorId?: string; startTime?: string; endTime?: string },
  options: {
    featureKey?: typeof INTERACTIVE_DEBUG_FEATURE_KEY | typeof SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY;
  } = {}
): Promise<DebugDiagnosis> {
  const featureKey = options.featureKey ?? INTERACTIVE_DEBUG_FEATURE_KEY;
  const config = resolveDebugAgentConfig(env);
  const window = await resolveWindow(env, input, config);
  const daily = await getFeatureTokenBudget(env.KV, featureKey, config.dailyTokenLimit, env);
  if (!daily.allowed) throw new Error('Daily deployment debugging budget exhausted');

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Diagnose ${window.errorId ? `platform error ${window.errorId}` : 'the selected error window'} from ${new Date(window.startMs).toISOString()} to ${new Date(window.endMs).toISOString()}.`,
    },
  ];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let diagnosis = '';
  let dailyTokensUsed = daily.usedTokens;

  while (turns < config.maxTurns) {
    const remaining = config.runTokenLimit - inputTokens - outputTokens;
    const requestEstimate = estimatedTokens(messages);
    if (remaining <= requestEstimate) throw new Error('Per-run debugging token ceiling reached');
    const maxTokens = Math.min(config.modelOutputTokens, remaining - requestEstimate);
    const reservation = await consumeFeatureTokenBudget(
      env.KV,
      featureKey,
      remaining,
      config.dailyTokenLimit,
      env
    );
    if (!reservation.allowed) throw new Error('Daily deployment debugging budget exhausted');
    let completion: Completion;
    try {
      completion = await complete(env, config, featureKey, messages, maxTokens);
    } catch (cause) {
      await releaseFeatureTokenBudget(env.KV, featureKey, remaining, config.dailyTokenLimit, env);
      throw cause;
    }
    turns++;
    const usedInput = completion.usage?.prompt_tokens ?? requestEstimate;
    const usedOutput = completion.usage?.completion_tokens ?? 0;
    const actualTokens = usedInput + usedOutput;
    inputTokens += usedInput;
    outputTokens += usedOutput;
    const released = await releaseFeatureTokenBudget(
      env.KV,
      featureKey,
      Math.max(0, remaining - actualTokens),
      config.dailyTokenLimit,
      env
    );
    dailyTokensUsed = released.usedTokens;
    if (inputTokens + outputTokens > config.runTokenLimit) {
      throw new Error('Per-run debugging token ceiling reached');
    }

    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('Debugging model returned no message');
    const toolCalls = message.tool_calls ?? [];
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });
    if (toolCalls.length === 0) {
      diagnosis = message.content?.trim() ?? '';
      break;
    }
    for (const call of toolCalls) {
      messages.push({
        role: 'tool',
        content: await executeTool(env, window, config, call),
        tool_call_id: call.id,
      });
    }
  }
  if (!diagnosis) throw new Error('Debugging agent reached its turn limit without a diagnosis');
  diagnosis = redactSensitiveData(diagnosis);

  const db = drizzle(env.DATABASE, { schema });
  const id = ulid();
  await db.insert(schema.debugDiagnoses).values({
    id,
    errorId: window.errorId,
    startTime: new Date(window.startMs).toISOString(),
    endTime: new Date(window.endMs).toISOString(),
    diagnosis,
    model: config.model,
    turns,
    inputTokens,
    outputTokens,
    dailyTokensUsed,
    dailyTokenLimit: config.dailyTokenLimit,
    createdBy,
  });
  const row = await db
    .select()
    .from(schema.debugDiagnoses)
    .where(eq(schema.debugDiagnoses.id, id))
    .get();
  if (!row) throw new Error('Failed to persist debugging diagnosis');
  return toDiagnosis(row);
}

export async function listDebugDiagnoses(
  env: Env,
  filter: { errorId?: string; startTime?: string; endTime?: string; summaryOnly?: boolean }
): Promise<{ diagnoses: DebugDiagnosis[]; runs: DebugDiagnosisRun[] }> {
  const db = drizzle(env.DATABASE, { schema });
  const diagnosisConditions = filter.errorId
    ? eq(schema.debugDiagnoses.errorId, filter.errorId)
    : filter.startTime && filter.endTime
      ? and(
          eq(schema.debugDiagnoses.startTime, filter.startTime),
          eq(schema.debugDiagnoses.endTime, filter.endTime)
        )
      : undefined;
  const runConditions = filter.errorId
    ? eq(schema.debugDiagnosisRuns.errorId, filter.errorId)
    : filter.startTime && filter.endTime
      ? and(
          eq(schema.debugDiagnosisRuns.startTime, filter.startTime),
          eq(schema.debugDiagnosisRuns.endTime, filter.endTime)
        )
      : undefined;
  const projection = {
    ...getTableColumns(schema.debugDiagnoses),
    ...(filter.summaryOnly ? { diagnosis: sql<string>`''` } : {}),
  };
  const [diagnosisRows, runRows] = await Promise.all([
    db
      .select(projection)
      .from(schema.debugDiagnoses)
      .where(diagnosisConditions)
      .orderBy(desc(schema.debugDiagnoses.createdAt))
      .limit(20),
    db
      .select()
      .from(schema.debugDiagnosisRuns)
      .where(runConditions)
      .orderBy(desc(schema.debugDiagnosisRuns.createdAt))
      .limit(50),
  ]);
  const diagnoses = diagnosisRows.map(toDiagnosis);
  const diagnosisById = new Map(diagnoses.map((diagnosis) => [diagnosis.id, diagnosis]));
  const missingDiagnosisIds = runRows
    .map((run) => run.diagnosisId)
    .filter((id): id is string => typeof id === 'string')
    .filter((id) => !diagnosisById.has(id));
  if (missingDiagnosisIds.length > 0) {
    const linked = await db
      .select(projection)
      .from(schema.debugDiagnoses)
      .where(or(...missingDiagnosisIds.map((id) => eq(schema.debugDiagnoses.id, id))));
    for (const diagnosis of linked.map(toDiagnosis)) diagnosisById.set(diagnosis.id, diagnosis);
  }
  return {
    diagnoses,
    runs: runRows.map((run) =>
      toDiagnosisRun(run, run.diagnosisId ? (diagnosisById.get(run.diagnosisId) ?? null) : null)
    ),
  };
}

export async function getDebugDiagnosisRun(
  env: Env,
  runId: string
): Promise<DebugDiagnosisRun | null> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select()
    .from(schema.debugDiagnosisRuns)
    .where(eq(schema.debugDiagnosisRuns.id, runId))
    .get();
  if (!row) return null;
  const [diagnosisRow, incident] = await Promise.all([
    row.diagnosisId
      ? db
          .select()
          .from(schema.debugDiagnoses)
          .where(eq(schema.debugDiagnoses.id, row.diagnosisId))
          .get()
      : Promise.resolve(null),
    row.errorId ? getDiagnosticIncidentByErrorId(env, row.errorId) : Promise.resolve(null),
  ]);
  const run = toDiagnosisRun(row, diagnosisRow ? toDiagnosis(diagnosisRow) : null);
  if (row.errorId) run.incident = incident;
  return run;
}

export async function saveDebugDiagnosisAsIdea(
  env: Env,
  diagnosisId: string,
  projectId: string,
  createdBy: string,
  title?: string
): Promise<{ ideaId: string }> {
  const db = drizzle(env.DATABASE, { schema });
  const diagnosis = await db
    .select()
    .from(schema.debugDiagnoses)
    .where(eq(schema.debugDiagnoses.id, diagnosisId))
    .get();
  if (!diagnosis) throw new Error('Diagnosis not found');
  if (diagnosis.ideaId) return { ideaId: diagnosis.ideaId };
  const project = await db
    .select({ id: schema.projects.id, userId: schema.projects.userId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) throw new Error('Project not found');
  const ideaId = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.tasks).values({
    id: ideaId,
    projectId: project.id,
    userId: project.userId,
    title: (title?.trim() || 'Investigate deployment diagnosis').slice(0, 200),
    description: diagnosis.diagnosis.slice(0, 5_000),
    status: 'draft',
    // This row is an idea, so it carries the flag the Ideas pages read. Without it the row
    // would show up in Ideas only while it stayed `draft` and would vanish the moment someone
    // marked it done (`db/migrations/0207_tasks_idea_flag.sql`).
    isIdea: true,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(schema.debugDiagnoses)
    .set({ ideaId })
    .where(eq(schema.debugDiagnoses.id, diagnosis.id));
  return { ideaId };
}
