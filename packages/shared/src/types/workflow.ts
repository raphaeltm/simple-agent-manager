/**
 * Read contract for durable workflow runs: the project Automation → Workflows pages and
 * `GET /api/projects/:projectId/workflows[/:runId]`.
 *
 * A run is a mission with a workflow plan (`missions.workflow_plan_json`). Its steps are
 * `mission_steps` rows that the workflow engine advances
 * (`apps/api/src/services/workflow-reconcile.ts`). The API projects runs and steps in one
 * place, `apps/api/src/services/workflow-run-read.ts`, so a new step field lands there once.
 */
import type { HandoffArtifactRef } from './mission';
import type { CompletionEvidence } from './task';

/**
 * What a run looks like to people. The engine stores `failed` for a run that ended with any
 * step not succeeding; that, and any status other than `active` or `completed`, reads as
 * `needs_attention`: the run is not progressing and did not succeed.
 */
export const WORKFLOW_RUN_STATUSES = ['active', 'completed', 'needs_attention'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * Engine step states (`mission_steps.state`). `waiting` covers both "prerequisites not done"
 * and "ready, not started yet"; `blocked` means a prerequisite did not succeed, so the step
 * never started. A `wait` step uses `running` while it listens for its event.
 */
export const WORKFLOW_STEP_STATUSES = [
  'waiting',
  'starting',
  'running',
  'completed',
  'failed',
  'blocked',
] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export function isWorkflowStepStatus(value: unknown): value is WorkflowStepStatus {
  return typeof value === 'string' && (WORKFLOW_STEP_STATUSES as readonly string[]).includes(value);
}

/**
 * `agent` starts an ordinary task chat. `wait` listens for a project event; it is reserved for
 * the event-wait slice, which fills {@link WorkflowStepWait} without changing this contract.
 */
export const WORKFLOW_STEP_KINDS = ['agent', 'wait'] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Runs per list page when the caller does not ask for a size. */
export const DEFAULT_WORKFLOW_RUN_LIST_LIMIT = 20;
/**
 * Largest list page. Bounds one response and its step-summary read (at most 25 steps per run);
 * callers page with `nextCursor` for more.
 */
export const MAX_WORKFLOW_RUN_LIST_LIMIT = 50;

/** One step in a list row: enough for a progress bar and the line that says what is happening. */
export interface WorkflowStepSummary {
  key: string;
  title: string;
  kind: WorkflowStepKind;
  status: WorkflowStepStatus;
  /**
   * The engine's own words: why a step failed or was blocked, or what a waiting/starting step
   * is held by (for example "Waiting for project task capacity"). Null when there is none.
   */
  reason: string | null;
}

export interface WorkflowRunSummary {
  id: string;
  title: string;
  status: WorkflowRunStatus;
  /** The member who owns the run (whose agent started it). */
  startedByUserId: string;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** When SAM stops the run if it has not finished. ISO. */
  deadlineAt: string | null;
  /** Every step, in plan order. */
  steps: WorkflowStepSummary[];
}

export interface WorkflowRunListResponse {
  /** Newest first. */
  runs: WorkflowRunSummary[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/**
 * A reference an agent published with its result, for example a Library file ID or a URL: a
 * `HandoffArtifactRef` as the engine stores it. `type` stays open because `publish_handoff`
 * accepts any type string and the engine keeps it as given; readers match the known kinds.
 */
export type WorkflowArtifactRef = Omit<HandoffArtifactRef, 'type' | 'description'> & {
  type: HandoffArtifactRef['type'] | (string & {});
};

/** What a finished step reported. Everything here was written by the step's agent. */
export interface WorkflowStepOutput {
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  /** Tests and checks the agent said it ran. Null when none, or when too long to keep. */
  evidence: CompletionEvidence | null;
  handoffs: Array<{ id: string; artifactRefs: WorkflowArtifactRef[] }>;
}

/** The agent profile the step was frozen with when the run was accepted. */
export interface WorkflowStepAgent {
  profileId: string;
  profileName: string | null;
  agentType: string | null;
  model: string | null;
}

/**
 * Event-wait state (event-wait slice). A `wait` step is `waiting` until its prerequisites
 * finish, `running` while it listens, `completed` when the event arrives and `failed` when it
 * times out (`timedOut`) or cannot listen (`reason`).
 */
export interface WorkflowStepWait {
  /** What the step waits for, in plain words, for example "CI finishes on commit abc1234". */
  description: string;
  source: string;
  eventTypes: string[];
  subject: { type: string; id: string } | null;
  /** When SAM started listening. ISO. */
  listeningSince: string | null;
  /** When the step fails if the event has not arrived. ISO. */
  timeoutAt: string | null;
  matchedEvent: {
    id: string;
    eventType: string;
    occurredAt: string;
    title: string | null;
  } | null;
  timedOut: boolean;
}

export interface WorkflowStepDetail extends WorkflowStepSummary {
  /** Position in the submitted plan, from 0. */
  ordinal: number;
  /** Keys of the steps that must succeed before this one starts. */
  after: string[];
  /** What the step's agent was asked to do (written by the agent that planned the run). */
  instructions: string;
  agent: WorkflowStepAgent | null;
  attemptId: string;
  /** The step's task and chat, once SAM has tried to start it. */
  taskId: string | null;
  sessionId: string | null;
  /** The task's own status, once its task exists. Null before that. */
  taskStatus: string | null;
  /** How many times SAM has tried, or confirmed, starting this step. */
  launchAttempts: number;
  /** ISO times from the run's lifecycle events. */
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  output: WorkflowStepOutput | null;
  wait: WorkflowStepWait | null;
}

/** One lifecycle event, oldest first. `stepKey` is null for run-level events. */
export interface WorkflowActivityEntry {
  at: string;
  stepKey: string | null;
  /**
   * The transition, from the event type: a step status (`starting`, `running`, `completed`,
   * `failed`, `blocked`) or, for the run, `completed` / `needs_attention`. Unknown values are
   * shown generically.
   */
  state: string;
}

export interface WorkflowRunDetail extends Omit<WorkflowRunSummary, 'steps'> {
  goal: string;
  /** The task and chat whose agent started the run. */
  startedFrom: { taskId: string; sessionId: string | null; title: string | null } | null;
  /** Most steps that run at once (admin setting `workflow.maxParallelSteps`). */
  maxParallelSteps: number | null;
  steps: WorkflowStepDetail[];
  activity: WorkflowActivityEntry[];
}

export interface WorkflowRunDetailResponse {
  run: WorkflowRunDetail;
}
