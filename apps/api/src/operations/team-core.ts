/**
 * One read of a team's progress: who is working, idle, asleep or waiting, on what, with which pull
 * request and evidence, and what usage SAM can actually measure.
 *
 * Every section names its source and when it was observed, and the sources disagree in kind:
 * task and session state are SAM's own records; pull request and check state are the last GitHub
 * webhook SAM stored; summaries and evidence are what the agent reported, not verified facts.
 * SAM does not record per-task token counts or which commit a deployment runs, so those are
 * reported as unavailable instead of being estimated.
 *
 * Each source is read once for the whole team (rule 60); a failing source marks its own section
 * unavailable rather than failing the read.
 */
import type { PullRequestState } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { chunk, D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { parseRowsSkippingInvalid } from '../lib/runtime-validation';
import { listAgentActivityTasks } from '../services/agent-activity';
import { getConnectorReadLimits } from '../services/connector-read-settings';
import { listProjectCredentialLimits } from '../services/credential-limit-events/read';
import * as projectDataService from '../services/project-data';
import { authorizeProjectOperation } from './authorization';
import { operationLink } from './connector-read-core';
import { diagnostic } from './operational-projections';
import { getPullRequestStates, parseProjectPullRequestUrl } from './pull-request-core';
import { jsonBytes, RESULT_FRAMING_RESERVE_BYTES, resultByteBudget } from './response-budget';
import { readTeamTasks, type TeamScope, type TeamTaskRow } from './team-lineage';
import { settle, type Settled, usageSection } from './team-usage';
import type { OperationContext } from './types';
import { untrustedTextBlock } from './untrusted-text';

/** Shortest agent text per field a large team is cut to before fewer tasks are listed. */
const MIN_TEAM_TEXT_CHARS = 100;

const AgentSessionRowSchema = v.object({
  workspaceId: v.string(),
  agentType: v.nullable(v.string()),
  agentProfileId: v.nullable(v.string()),
  providerMode: v.nullable(v.string()),
  credentialSource: v.nullable(v.string()),
  status: v.string(),
});
type AgentSessionRow = v.InferOutput<typeof AgentSessionRowSchema>;

const ComputeRowSchema = v.object({
  workspaceId: v.string(),
  intervals: v.number(),
  openIntervals: v.number(),
  durationMs: v.nullable(v.number()),
  vcpuMs: v.nullable(v.number()),
});
type ComputeRow = v.InferOutput<typeof ComputeRowSchema>;

/** Rows that fail their schema are left out (and logged) rather than failing the section. */
function parseRows<TSchema extends v.GenericSchema>(
  schema: TSchema,
  rows: readonly unknown[],
  context: string
): Array<v.InferOutput<TSchema>> {
  return parseRowsSkippingInvalid(schema, rows, (reason) =>
    log.warn('connector.team_row_skipped', { context, reason })
  );
}

function jsonIds(ids: readonly (string | null)[]): string {
  return JSON.stringify([...new Set(ids.filter((id): id is string => !!id))]);
}

async function readAgentSessions(ctx: OperationContext, workspaceIds: string) {
  const result = await ctx.env.DATABASE.prepare(
    `SELECT workspace_id AS workspaceId, agent_type AS agentType, agent_profile_id AS agentProfileId,
            agent_provider_mode AS providerMode, agent_credential_source AS credentialSource,
            status
     FROM agent_sessions WHERE workspace_id IN (SELECT value FROM json_each(?))
     ORDER BY created_at DESC, id DESC`
  )
    .bind(workspaceIds)
    .all<Record<string, unknown>>();
  const newest = new Map<string, AgentSessionRow>();
  for (const row of parseRows(AgentSessionRowSchema, result.results ?? [], 'agent_sessions')) {
    if (!newest.has(row.workspaceId)) newest.set(row.workspaceId, row);
  }
  return newest;
}

async function readCompute(ctx: OperationContext, workspaceIds: string, now: string) {
  // Measured workspace intervals. A node can host several workspaces, so these are runtime
  // minutes per workspace, not a share of any bill.
  const result = await ctx.env.DATABASE.prepare(
    `SELECT workspace_id AS workspaceId, COUNT(*) AS intervals,
            SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS openIntervals,
            SUM((julianday(COALESCE(ended_at, ?)) - julianday(started_at)) * 86400000) AS durationMs,
            SUM((julianday(COALESCE(ended_at, ?)) - julianday(started_at)) * 86400000 * vcpu_count)
              AS vcpuMs
     FROM compute_usage WHERE workspace_id IN (SELECT value FROM json_each(?))
     GROUP BY workspace_id`
  )
    .bind(now, now, workspaceIds)
    .all<Record<string, unknown>>();
  const rows = parseRows(ComputeRowSchema, result.results ?? [], 'compute_usage');
  return new Map(rows.map((row) => [row.workspaceId, row]));
}

async function readSessions(ctx: OperationContext, projectId: string, taskIds: string[]) {
  const byTask = new Map<string, Record<string, unknown>>();
  // The ProjectData lookup binds one parameter per task id and nothing else; Cloudflare's SQL
  // surfaces (D1 and Durable Object storage alike) reject the statement past that limit.
  for (const taskChunk of chunk(taskIds, D1_MAX_BOUND_PARAMETERS)) {
    for (const session of await projectDataService.getSessionsByTaskIds(
      ctx.env,
      projectId,
      taskChunk
    )) {
      const taskId = typeof session.taskId === 'string' ? session.taskId : null;
      if (taskId && !byTask.has(taskId)) byTask.set(taskId, session);
    }
  }
  return byTask;
}

function minutes(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms / 6_000) / 10 : null;
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** What the task is waiting on, derived from SAM's own records only. */
function waitingOn(task: TeamTaskRow, attentionKind: string | null): string[] {
  const reasons: string[] = [];
  if (attentionKind === 'needs_input') reasons.push('person');
  if (task.admissionState === 'provider_limit_waiting') reasons.push('provider_limit_reset');
  if (task.admissionState === 'provider_limit_blocked') reasons.push('provider_limit');
  if (task.credentialBlockedReason) reasons.push('credentials');
  if (task.executionStep === 'waiting_for_node_capacity') reasons.push('node_capacity');
  if (task.executionStep === 'awaiting_followup') reasons.push('next_message');
  return reasons;
}

function providerLimitReset(task: TeamTaskRow) {
  const wait = parseJson(task.providerLimitWaitJson);
  if (!wait || typeof wait !== 'object') return null;
  const record = wait as Record<string, unknown>;
  return typeof record.resetsAt === 'string' || typeof record.resetsAt === 'number'
    ? { resetsAt: record.resetsAt, source: 'provider_reported' }
    : null;
}

function sessionAttention(
  session: Record<string, unknown> | undefined,
  callerId: string,
  textChars: number
) {
  const attention = session?.attention;
  if (!attention || typeof attention !== 'object') return null;
  const record = attention as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : null;
  // The question itself is shown to the person who started the chat, as in chat lists.
  const mine = session?.createdByUserId === callerId;
  return {
    markerId: typeof record.markerId === 'string' ? record.markerId : null,
    kind,
    createdAt:
      typeof record.createdAt === 'number' ? new Date(record.createdAt).toISOString() : null,
    ...(mine
      ? {
          question: untrustedTextBlock({
            kind: 'agent question',
            text: typeof record.reason === 'string' ? record.reason : null,
            maxLength: textChars,
            moreWith: 'sam_chat_interactions',
          }),
          options: Array.isArray(record.options) ? record.options : [],
        }
      : { question: 'Visible to the chat owner; they can read it with sam_chat_interactions.' }),
  };
}

interface PullRequestLookup {
  repository: string | null;
  states: Record<string, PullRequestState | null>;
}

async function readPullRequests(
  ctx: OperationContext,
  projectId: string,
  tasks: readonly TeamTaskRow[]
): Promise<PullRequestLookup> {
  const project = await ctx.env.DATABASE.prepare('SELECT repository FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ repository: string }>();
  const repository = project?.repository ?? null;
  if (!repository) return { repository, states: {} };
  const refs = tasks.flatMap((task) => (task.outputPrUrl ? [{ url: task.outputPrUrl }] : []));
  return { repository, states: await getPullRequestStates(ctx, projectId, refs, { repository }) };
}

function pullRequest(task: TeamTaskRow, lookup: Settled<PullRequestLookup>) {
  if (!task.outputPrUrl) return null;
  if (!lookup.ok) return { url: task.outputPrUrl, state: 'unavailable' };
  const parsed = lookup.value.repository
    ? parseProjectPullRequestUrl(task.outputPrUrl, lookup.value.repository)
    : null;
  // A URL outside the project's repository has no stored state to report.
  if (!parsed) return { url: task.outputPrUrl, state: 'not_tracked' };
  const url = parsed.url;
  const state = lookup.value.states[url];
  if (!state) return { url, state: 'not_synced', source: 'github_webhook' };
  return {
    url,
    state: state.state,
    isDraft: state.isDraft,
    checks: state.checksState ?? 'unknown',
    headSha: state.headSha ?? null,
    checksUpdatedAt: state.checksUpdatedAt ?? null,
    mergedAt: state.mergedAt,
    updatedAt: state.updatedAt,
    stale: state.stale,
    source: 'github_webhook',
  };
}

interface TaskSources {
  activity: string;
  session: Record<string, unknown> | undefined;
  agent: AgentSessionRow | undefined;
  usage: ComputeRow | undefined;
  pullRequests: Settled<PullRequestLookup>;
}

function projectTeamTask(
  ctx: OperationContext,
  input: { projectId: string; scope: TeamScope },
  task: TeamTaskRow,
  sources: TaskSources,
  textChars: number
) {
  const { session, agent, usage } = sources;
  const attention = sessionAttention(session, ctx.actor.userId, textChars);
  return {
    taskId: task.id,
    title: task.title,
    parentTaskId: task.parentTaskId,
    depth: task.depth,
    // Retries and forks also set parent_task_id; dispatched subtasks come from MCP dispatch.
    relation:
      task.depth === 0 && input.scope.kind !== 'channel'
        ? 'root'
        : task.triggeredBy === 'mcp' || task.dispatchDepth > 0
          ? 'subtask'
          : 'retry_or_fork',
    status: task.status,
    executionStep: task.executionStep,
    activity: sources.activity,
    waitingOn: waitingOn(task, attention?.kind ?? null),
    providerLimit: providerLimitReset(task),
    attention,
    error: diagnostic(task.errorMessage, 'TASK_ERROR'),
    chat: task.chatSessionId
      ? {
          sessionId: task.chatSessionId,
          status: typeof session?.status === 'string' ? session.status : 'unknown',
          lastMessageAt:
            typeof session?.lastMessageAt === 'number'
              ? new Date(session.lastMessageAt).toISOString()
              : null,
          agentCompletedAt:
            typeof session?.agentCompletedAt === 'number'
              ? new Date(session.agentCompletedAt).toISOString()
              : null,
          link: operationLink(ctx, input.projectId, task.chatSessionId),
        }
      : null,
    agent: agent
      ? {
          agentType: agent.agentType,
          agentProfileId: agent.agentProfileId,
          providerMode: agent.providerMode,
          credentialSource: agent.credentialSource,
          sessionStatus: agent.status,
        }
      : null,
    pullRequest: pullRequest(task, sources.pullRequests),
    output: {
      branch: task.outputBranch,
      commitSha: task.outputCommitSha,
      summary: untrustedTextBlock({
        kind: 'agent summary',
        text: task.outputSummary,
        maxLength: textChars,
        moreWith: 'sam_task_get',
      }),
      evidence: untrustedTextBlock({
        kind: 'agent evidence',
        text: task.completionEvidence,
        maxLength: textChars,
        moreWith: 'sam_task_get',
      }),
      source: 'agent_reported_not_verified',
    },
    compute: usage
      ? {
          runtimeMinutes: minutes(usage.durationMs),
          vcpuMinutes: minutes(usage.vcpuMs),
          runningNow: usage.openIntervals > 0,
          source: 'measured_workspace_intervals',
        }
      : null,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

export type TeamTask = ReturnType<typeof projectTeamTask>;

/**
 * The tasks that fit `budget` bytes. Agent text is shortened first, since sam_task_get returns it
 * in full; then the lowest-ranked tasks (deepest, least active, least recently updated, as
 * `team-lineage.ts` orders them) are left out. The caller discloses both.
 */
function fitTasks(project: (textChars: number) => TeamTask[], textChars: number, budget: number) {
  let chars = textChars;
  let tasks = project(chars);
  while (jsonBytes(tasks) > budget && chars > MIN_TEAM_TEXT_CHARS) {
    chars = Math.max(MIN_TEAM_TEXT_CHARS, Math.floor(chars / 2));
    tasks = project(chars);
  }
  // One byte per task for the separating comma, two for the brackets.
  const sizes = tasks.map((task) => jsonBytes(task) + 1);
  let total = sizes.reduce((sum, size) => sum + size, 2);
  let listed = tasks.length;
  while (listed > 1 && total > budget) {
    listed -= 1;
    total -= sizes[listed] ?? 0;
  }
  return { tasks: tasks.slice(0, listed), textChars: chars, notListed: tasks.length - listed };
}

function omittedNote(readCapped: boolean, maxTasks: number, notListed: number): string | null {
  const notes: string[] = [];
  if (readCapped)
    notes.push(`More than ${maxTasks} tasks match, so the least relevant were not read.`);
  if (notListed > 0) {
    notes.push(
      `${notListed} of the tasks read are not listed, to fit the response: the deepest, least active and least recently updated.`
    );
  }
  if (notes.length === 0) return null;
  notes.push(
    "Call sam_team_status with a subtask's taskId to read its branch, sam_task_get for one task, or sam_tasks_list to list them."
  );
  return notes.join(' ');
}

export async function teamStatus(
  ctx: OperationContext,
  input: { projectId: string; scope: TeamScope }
) {
  await authorizeProjectOperation(ctx, input.projectId);
  const limits = await getConnectorReadLimits(ctx.env);
  const team = await readTeamTasks(ctx.env, input.projectId, input.scope, {
    maxTasks: limits.teamMaxTasks,
    maxDepth: limits.teamMaxDepth,
  });
  const taskIds = team.rows.map((task) => task.id);
  const workspaceIds = jsonIds(team.rows.map((task) => task.workspaceId));
  const now = new Date();
  const [activity, sessions, prStates, agents, compute, quotas] = await Promise.all([
    settle('agent_activity', () =>
      listAgentActivityTasks(ctx.env, { projectId: input.projectId, activeOnly: false, taskIds })
    ),
    settle('sessions', () => readSessions(ctx, input.projectId, taskIds)),
    settle('pull_requests', () => readPullRequests(ctx, input.projectId, team.rows)),
    settle('agent_sessions', () => readAgentSessions(ctx, workspaceIds)),
    settle('compute_usage', () => readCompute(ctx, workspaceIds, now.toISOString())),
    settle('credential_limits', () =>
      listProjectCredentialLimits(ctx.env, {
        projectId: input.projectId,
        userId: ctx.actor.userId,
      })
    ),
  ]);
  const states = new Map(activity.ok ? activity.value.map((row) => [row.id, row]) : []);
  const project = (textChars: number) =>
    team.rows.map((task) =>
      projectTeamTask(
        ctx,
        input,
        task,
        {
          activity: activity.ok
            ? (states.get(task.id)?.agentActivityState ?? 'unknown')
            : 'unavailable',
          session: sessions.ok ? sessions.value.get(task.id) : undefined,
          agent: agents.ok && task.workspaceId ? agents.value.get(task.workspaceId) : undefined,
          usage: compute.ok && task.workspaceId ? compute.value.get(task.workspaceId) : undefined,
          pullRequests: prStates,
        },
        textChars
      )
    );

  // Counts and usage cover every task read, including any the listing leaves out.
  const everyTask = project(limits.teamTextChars);
  const summary = {
    projectId: input.projectId,
    scope: input.scope,
    rootTaskId: team.rootTaskId,
    observedAt: now.toISOString(),
    counts: summarize(everyTask),
    usage: await usageSection(ctx, everyTask, compute.ok, quotas),
    deployments: {
      deployedCommit: 'not_recorded',
      note: 'SAM does not record which commit a deployment runs; check the deploy workflow.',
    },
    sources: {
      status: 'sam_records',
      activity: activity.ok ? 'sam_records_not_live_verified' : 'unavailable',
      sessions: sessions.ok ? 'project_data' : 'unavailable',
      pullRequests: prStates.ok ? 'github_webhook_last_stored' : 'unavailable',
      agentText: 'agent_reported_not_verified',
    },
  };
  const fitted = fitTasks(
    project,
    limits.teamTextChars,
    resultByteBudget(ctx.env) - jsonBytes(summary) - RESULT_FRAMING_RESERVE_BYTES
  );
  const omitted = omittedNote(team.truncated, limits.teamMaxTasks, fitted.notListed);

  return {
    projectId: summary.projectId,
    scope: summary.scope,
    rootTaskId: summary.rootTaskId,
    observedAt: summary.observedAt,
    counts: { ...summary.counts, listed: fitted.tasks.length },
    tasks: fitted.tasks,
    agentTextCharsPerField: fitted.textChars,
    truncated: team.truncated || fitted.notListed > 0,
    ...(omitted ? { omitted } : {}),
    usage: summary.usage,
    deployments: summary.deployments,
    sources: summary.sources,
  };
}

function summarize(tasks: readonly TeamTask[]) {
  const count = (values: string[]) =>
    values.reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {});
  const prs = tasks.flatMap((task) => (task.pullRequest ? [task.pullRequest] : []));
  return {
    tasks: tasks.length,
    byStatus: count(tasks.map((task) => task.status)),
    byActivity: count(tasks.map((task) => task.activity)),
    waitingOnPerson: tasks.filter((task) => task.waitingOn.includes('person')).length,
    openPullRequests: prs.filter((pr) => pr.state === 'open').length,
    failingChecks: prs.filter((pr) => 'checks' in pr && pr.checks === 'failure').length,
  };
}
