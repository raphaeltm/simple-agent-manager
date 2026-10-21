/**
 * The one read of a durable workflow run, shared by every surface (policy 5cb362e8): MCP
 * `get_workflow_run` for the owner's agent and REST `GET /api/projects/:projectId/workflows`
 * for project members (`routes/workflows.ts`). Callers authorize first; this module loads
 * rows scoped to the project and projects them into each surface's shape.
 *
 * JSON columns are parsed field by field (rule 50): a malformed value degrades that field and
 * logs `workflow_read.field_skipped`; it never fails the whole read.
 */
import {
  DEFAULT_WORKFLOW_RUN_LIST_LIMIT,
  isWorkflowStepStatus,
  MAX_WORKFLOW_RUN_LIST_LIMIT,
  parseCompletionEvidenceJson,
  type WorkflowActivityEntry,
  type WorkflowRunDetail,
  type WorkflowRunListResponse,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowStepAgent,
  type WorkflowStepDetail,
  type WorkflowStepOutput,
  type WorkflowStepStatus,
  type WorkflowStepSummary,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { getWorkflowConfig } from './workflow-config';
import { workflowDependencies, workflowResult } from './workflow-state-validation';

const RUN_ROW = v.object({
  id: v.string(),
  project_id: v.string(),
  user_id: v.string(),
  title: v.string(),
  description: v.nullable(v.string()),
  status: v.string(),
  root_task_id: v.nullable(v.string()),
  workflow_deadline_at: v.nullable(v.number()),
  created_at: v.string(),
  updated_at: v.string(),
});
const STEP_ROW = v.object({
  step_key: v.string(),
  ordinal: v.number(),
  title: v.string(),
  instructions: v.string(),
  after_json: v.string(),
  profile_id: v.string(),
  profile_snapshot_json: v.string(),
  state: v.string(),
  attempt_id: v.string(),
  task_id: v.string(),
  session_id: v.string(),
  /** 1 once SAM recorded the step's launch intent (`submission_json`); the prompt is not read. */
  submitted: v.number(),
  launch_retries: v.number(),
  result_json: v.nullable(v.string()),
  reason: v.nullable(v.string()),
  updated_at: v.string(),
});
const EVENT_ROW = v.object({
  id: v.string(),
  event_type: v.string(),
  event_payload_json: v.string(),
  created_at: v.string(),
});
const TASK_ROW = v.object({
  id: v.string(),
  status: v.string(),
  title: v.nullable(v.string()),
  chat_session_id: v.nullable(v.string()),
});
type RunRow = v.InferOutput<typeof RUN_ROW>;
type StepRow = v.InferOutput<typeof STEP_ROW>;
type EventRow = v.InferOutput<typeof EVENT_ROW>;
type TaskRow = v.InferOutput<typeof TASK_ROW>;

export interface LoadedWorkflowRun {
  run: RunRow;
  steps: StepRow[];
  events: EventRow[];
  /** The run's step tasks and root task that exist in the run's project, by task ID. */
  tasks: Map<string, TaskRow>;
}

/** Stored mission status as people read it; see `WORKFLOW_RUN_STATUSES`. */
export function toWorkflowRunStatus(stored: string): WorkflowRunStatus {
  return stored === 'active' || stored === 'completed' ? stored : 'needs_attention';
}

function fieldSkipped(runId: string, field: string, stepKey: string | null, error: unknown) {
  log.warn('workflow_read.field_skipped', {
    runId,
    field,
    stepKey,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Parse each row on its own; a row that does not match is logged and left out (rule 50). */
function parseRows<TSchema extends v.GenericSchema>(
  schema: TSchema,
  rows: readonly unknown[] | undefined,
  runId: string,
  table: string
): Array<v.InferOutput<TSchema>> {
  const parsed: Array<v.InferOutput<TSchema>> = [];
  for (const row of rows ?? []) {
    const result = v.safeParse(schema, row);
    if (result.success) parsed.push(result.output);
    else
      fieldSkipped(runId, table, null, new Error(result.issues.map((i) => i.message).join('; ')));
  }
  return parsed;
}

const RUN_COLUMNS =
  'id, project_id, user_id, title, description, status, root_task_id, workflow_deadline_at, created_at, updated_at';

/**
 * Load one run of `projectId`, or null when it does not exist there. `ownerUserId` narrows the
 * read to that owner's runs (MCP); omit it for a project-wide read (REST, after `task:read`).
 * Two round trips: the run, then one batch for its steps, events and linked tasks.
 */
export async function loadWorkflowRun(
  env: Env,
  input: { projectId: string; runId: string; ownerUserId?: string }
): Promise<LoadedWorkflowRun | null> {
  const owner = input.ownerUserId === undefined ? '' : ' AND user_id = ?';
  const found = await env.DATABASE.prepare(
    `SELECT ${RUN_COLUMNS} FROM missions
     WHERE id = ? AND project_id = ? AND workflow_plan_json IS NOT NULL${owner}`
  )
    .bind(
      input.runId,
      input.projectId,
      ...(input.ownerUserId === undefined ? [] : [input.ownerUserId])
    )
    .first();
  if (!found) return null;
  // A run row that no longer parses reads as not found, with the reason logged (rule 50).
  const [run] = parseRows(RUN_ROW, [found], input.runId, 'missions');
  if (!run) return null;
  const [steps, events, tasks] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `SELECT step_key, ordinal, title, instructions, after_json, profile_id, profile_snapshot_json,
       state, attempt_id, task_id, session_id, submission_json IS NOT NULL AS submitted,
       launch_retries, result_json, reason, updated_at
       FROM mission_steps WHERE mission_id = ? ORDER BY ordinal`
    ).bind(run.id),
    // Each step attempt records at most starting, running and one outcome; the run one outcome.
    // The bound is therefore never reached, so the activity is complete (rule 65).
    env.DATABASE.prepare(
      `SELECT id, event_type, event_payload_json, created_at FROM mission_workflow_events
       WHERE mission_id = ? ORDER BY created_at, id
       LIMIT (SELECT COUNT(*) * 4 + 2 FROM mission_steps WHERE mission_id = ?)`
    ).bind(run.id, run.id),
    env.DATABASE.prepare(
      `SELECT id, status, title, chat_session_id FROM tasks
       WHERE project_id = ? AND (id = ? OR id IN (SELECT task_id FROM mission_steps WHERE mission_id = ?))`
    ).bind(run.project_id, run.root_task_id, run.id),
  ]);
  return {
    run,
    steps: parseRows(STEP_ROW, steps?.results, run.id, 'mission_steps'),
    events: parseRows(EVENT_ROW, events?.results, run.id, 'mission_workflow_events'),
    tasks: new Map(
      parseRows(TASK_ROW, tasks?.results, run.id, 'tasks').map((task) => [task.id, task])
    ),
  };
}

// ---------------------------------------------------------------------------
// Field parsers (each degrades only its own field)
// ---------------------------------------------------------------------------

const PROFILE_SNAPSHOT = v.object({
  profileName: v.optional(v.nullable(v.string())),
  agentType: v.optional(v.nullable(v.string())),
  model: v.optional(v.nullable(v.string())),
});

function stepAgent(runId: string, row: StepRow): WorkflowStepAgent {
  const agent: WorkflowStepAgent = {
    profileId: row.profile_id,
    profileName: null,
    agentType: null,
    model: null,
  };
  try {
    const snapshot = v.parse(PROFILE_SNAPSHOT, JSON.parse(row.profile_snapshot_json));
    agent.profileName = snapshot.profileName ?? null;
    agent.agentType = snapshot.agentType ?? null;
    agent.model = snapshot.model ?? null;
  } catch (error) {
    fieldSkipped(runId, 'profile_snapshot_json', row.step_key, error);
  }
  return agent;
}

function stepAfter(runId: string, row: StepRow): string[] {
  try {
    return workflowDependencies(row.after_json);
  } catch (error) {
    fieldSkipped(runId, 'after_json', row.step_key, error);
    return [];
  }
}

const EVIDENCE_FIELD = v.object({ completionEvidence: v.optional(v.nullable(v.string())) });

function stepOutput(runId: string, row: StepRow): WorkflowStepOutput | null {
  if (!row.result_json) return null;
  try {
    const result = workflowResult(row.result_json);
    // The engine keeps the evidence JSON cut to its handoff budget; a cut value no longer
    // parses and reads as no evidence (the step's chat still has it).
    const evidence = v.parse(EVIDENCE_FIELD, JSON.parse(row.result_json)).completionEvidence;
    return {
      summary: result.summary ?? null,
      branch: result.branch ?? null,
      prUrl: result.prUrl ?? null,
      evidence: parseCompletionEvidenceJson(evidence ?? null),
      handoffs: result.handoffs,
    };
  } catch (error) {
    fieldSkipped(runId, 'result_json', row.step_key, error);
    return null;
  }
}

const EVENT_PAYLOAD = v.object({
  metadata: v.object({ stepId: v.optional(v.string()), attemptId: v.optional(v.string()) }),
});
const EVENT_TYPE = /^workflow\.(step|run)\.([a-z_]+)$/;

interface ParsedEvent {
  at: string;
  stepKey: string | null;
  attemptId: string | null;
  state: string;
}

function parseEvent(runId: string, row: EventRow): ParsedEvent | null {
  const match = EVENT_TYPE.exec(row.event_type);
  if (!match?.[1] || !match[2]) {
    fieldSkipped(runId, `event:${row.id}`, null, new Error(`Unknown event type ${row.event_type}`));
    return null;
  }
  if (match[1] === 'run')
    return { at: row.created_at, stepKey: null, attemptId: null, state: match[2] };
  try {
    const { metadata } = v.parse(EVENT_PAYLOAD, JSON.parse(row.event_payload_json));
    if (!metadata.stepId) throw new Error('Step event without stepId');
    return {
      at: row.created_at,
      stepKey: metadata.stepId,
      attemptId: metadata.attemptId ?? null,
      state: match[2],
    };
  } catch (error) {
    fieldSkipped(runId, `event:${row.id}`, null, error);
    return null;
  }
}

const OUTCOME_STATES = new Set(['completed', 'failed', 'blocked']);

// ---------------------------------------------------------------------------
// REST projections
// ---------------------------------------------------------------------------

function stepDetail(
  loaded: LoadedWorkflowRun,
  row: StepRow,
  events: ParsedEvent[]
): WorkflowStepDetail | null {
  const runId = loaded.run.id;
  if (!isWorkflowStepStatus(row.state)) {
    fieldSkipped(runId, 'state', row.step_key, new Error(`Unknown step state ${row.state}`));
    return null;
  }
  const task = loaded.tasks.get(row.task_id) ?? null;
  // The current attempt's lifecycle; events recorded without an attempt still count.
  const own = events.filter(
    (event) =>
      event.stepKey === row.step_key && (!event.attemptId || event.attemptId === row.attempt_id)
  );
  const started =
    own.find((event) => event.state === 'starting') ??
    own.find((event) => event.state === 'running');
  const finished = own.find((event) => OUTCOME_STATES.has(event.state));
  return {
    key: row.step_key,
    title: row.title,
    kind: 'agent',
    status: row.state,
    reason: row.reason,
    ordinal: row.ordinal,
    after: stepAfter(runId, row),
    instructions: row.instructions,
    agent: stepAgent(runId, row),
    attemptId: row.attempt_id,
    // Identities are reserved when the run is accepted; show them once a start was attempted.
    taskId: row.submitted || task ? row.task_id : null,
    sessionId: task?.chat_session_id ?? null,
    taskStatus: task?.status ?? null,
    launchAttempts: row.launch_retries,
    startedAt: started?.at ?? null,
    finishedAt: finished?.at ?? null,
    updatedAt: row.updated_at,
    output: stepOutput(runId, row),
    wait: null,
  };
}

const isoOrNull = (epochMs: number | null) =>
  typeof epochMs === 'number' && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;

/** The REST detail for project members. `maxParallelSteps` comes from the live setting. */
export async function toWorkflowRunDetail(
  env: Env,
  loaded: LoadedWorkflowRun
): Promise<WorkflowRunDetail> {
  const { run } = loaded;
  const events = loaded.events
    .map((row) => parseEvent(run.id, row))
    .filter((event): event is ParsedEvent => event !== null);
  const steps = loaded.steps
    .map((row) => stepDetail(loaded, row, events))
    .filter((step): step is WorkflowStepDetail => step !== null);
  const root = run.root_task_id ? (loaded.tasks.get(run.root_task_id) ?? null) : null;
  let maxParallelSteps: number | null = null;
  try {
    maxParallelSteps = (await getWorkflowConfig(env)).maxParallelSteps;
  } catch (error) {
    fieldSkipped(run.id, 'maxParallelSteps', null, error);
  }
  const activity: WorkflowActivityEntry[] = events.map((event) => ({
    at: event.at,
    stepKey: event.stepKey,
    state: event.state,
  }));
  return {
    id: run.id,
    title: run.title,
    goal: run.description ?? '',
    status: toWorkflowRunStatus(run.status),
    startedByUserId: run.user_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    deadlineAt: isoOrNull(run.workflow_deadline_at),
    startedFrom: root
      ? { taskId: root.id, sessionId: root.chat_session_id, title: root.title }
      : null,
    maxParallelSteps,
    steps,
    activity,
  };
}

/** The owner's MCP view. Its shape predates the REST contract and must not change. */
export function toMcpWorkflowRun(loaded: LoadedWorkflowRun) {
  const { run } = loaded;
  return {
    runId: run.id,
    title: run.title,
    goal: run.description,
    status: toWorkflowRunStatus(run.status),
    deadlineAt: run.workflow_deadline_at,
    steps: loaded.steps.map((step) => ({
      key: step.step_key,
      title: step.title,
      after: stepAfter(run.id, step),
      status: step.state,
      attemptId: step.attempt_id,
      taskId: step.submitted ? step.task_id : null,
      sessionId: step.submitted ? step.session_id : null,
      reason: step.reason,
      launchRetries: step.launch_retries,
      result: mcpResult(run.id, step),
    })),
    activity: loaded.events.flatMap((event) => {
      try {
        return [
          {
            eventType: event.event_type,
            at: event.created_at,
            event: JSON.parse(event.event_payload_json) as unknown,
          },
        ];
      } catch (error) {
        fieldSkipped(run.id, `event:${event.id}`, null, error);
        return [];
      }
    }),
  };
}

function mcpResult(runId: string, step: StepRow): unknown {
  if (!step.result_json) return null;
  try {
    return JSON.parse(step.result_json) as unknown;
  } catch (error) {
    fieldSkipped(runId, 'result_json', step.step_key, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Longest step reason a list row carries; the run page shows the full text. */
export const WORKFLOW_LIST_REASON_MAX_CHARS = 300;

const LIST_RUN_ROW = v.object({
  id: v.string(),
  user_id: v.string(),
  title: v.string(),
  status: v.string(),
  workflow_deadline_at: v.nullable(v.number()),
  created_at: v.string(),
  updated_at: v.string(),
});
const LIST_STEP_ROW = v.object({
  mission_id: v.string(),
  step_key: v.string(),
  title: v.string(),
  state: v.string(),
  reason: v.nullable(v.string()),
});
/** The two columns a page position needs; both are NOT NULL in `missions`. */
const PAGE_POSITION = v.object({ id: v.string(), created_at: v.string() });

/** An opaque position after the last run of a page: its creation time and ID. */
function encodeCursor(row: v.InferOutput<typeof PAGE_POSITION>): string {
  return btoa(JSON.stringify([row.created_at, row.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

const CURSOR = v.tuple([v.string(), v.string()]);

function decodeCursor(cursor: string): [string, string] {
  try {
    const json = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    return v.parse(CURSOR, JSON.parse(json));
  } catch {
    throw errors.badRequest('cursor is not valid');
  }
}

/** Clamp a requested page size to the contract's bounds. */
export function workflowRunListLimit(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested) || requested < 1)
    return DEFAULT_WORKFLOW_RUN_LIST_LIMIT;
  return Math.min(Math.floor(requested), MAX_WORKFLOW_RUN_LIST_LIMIT);
}

const STATUS_PREDICATE: Record<WorkflowRunStatus, string> = {
  active: " AND status = 'active'",
  completed: " AND status = 'completed'",
  // Mirrors toWorkflowRunStatus: everything that is neither active nor completed.
  needs_attention: " AND status NOT IN ('active', 'completed')",
};

/** Runs of one project, newest first, each with a summary of every step. */
export async function listWorkflowRuns(
  env: Env,
  projectId: string,
  options: { status: WorkflowRunStatus | null; cursor: string | null; limit: number }
): Promise<WorkflowRunListResponse> {
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const page = await env.DATABASE.prepare(
    `SELECT id, user_id, title, status, workflow_deadline_at, created_at, updated_at
     FROM missions
     WHERE project_id = ? AND workflow_plan_json IS NOT NULL${options.status ? STATUS_PREDICATE[options.status] : ''}${
       after ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''
     }
     ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(projectId, ...(after ? [after[0], after[0], after[1]] : []), options.limit + 1)
    .all();
  // Page position comes from the raw last row, so a malformed row cannot end paging early.
  const pageRows = page.results.slice(0, options.limit);
  const last = v.safeParse(PAGE_POSITION, pageRows.at(-1));
  const nextCursor =
    page.results.length > options.limit && last.success ? encodeCursor(last.output) : null;
  const rows = parseRows(LIST_RUN_ROW, pageRows, `project:${projectId}`, 'missions');
  if (!rows.length) return { runs: [], nextCursor };

  const steps = await env.DATABASE.prepare(
    `SELECT mission_id, step_key, title, state, substr(reason, 1, ?) AS reason
     FROM mission_steps WHERE mission_id IN (${rows.map(() => '?').join(',')})
     ORDER BY mission_id, ordinal`
  )
    .bind(WORKFLOW_LIST_REASON_MAX_CHARS, ...rows.map((row) => row.id))
    .all();
  const byRun = new Map<string, WorkflowStepSummary[]>();
  for (const step of parseRows(
    LIST_STEP_ROW,
    steps.results,
    `project:${projectId}`,
    'mission_steps'
  )) {
    if (!isWorkflowStepStatus(step.state)) {
      fieldSkipped(
        step.mission_id,
        'state',
        step.step_key,
        new Error(`Unknown step state ${step.state}`)
      );
      continue;
    }
    const status: WorkflowStepStatus = step.state;
    const list = byRun.get(step.mission_id) ?? [];
    list.push({
      key: step.step_key,
      title: step.title,
      kind: 'agent',
      status,
      reason: step.reason,
    });
    byRun.set(step.mission_id, list);
  }
  const runs: WorkflowRunSummary[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: toWorkflowRunStatus(row.status),
    startedByUserId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: isoOrNull(row.workflow_deadline_at),
    steps: byRun.get(row.id) ?? [],
  }));
  return { runs, nextCursor };
}
