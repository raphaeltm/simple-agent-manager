/**
 * The Project Overview's one aggregated read (Inbox slice F1, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9,
 * section 4.2): what is running in a project and what happened recently.
 *
 * Budgets and Automations are not here on purpose. Their rules (which account a profile runs on,
 * when an automation needs attention) live in the web app's shared models, and the page reuses
 * those models and their cached reads rather than restating the rules on the server.
 *
 * Round trips: authorization (the access port's membership read), then in parallel the running
 * query (1), the merged pull requests (1) and the ideas list (`listIdeasWithDerivedStatus`, about
 * ten). Within the 20 a dashboard read may spend (`.claude/rules/60`).
 */
import {
  DEFAULT_PROJECT_OVERVIEW_RECENT_LIMIT,
  DEFAULT_PROJECT_OVERVIEW_RUNNING_LIMIT,
  type IdeaListItem,
  MAX_PROJECT_OVERVIEW_LIMIT,
  type OverviewMergedPullRequest,
  type OverviewRunningChat,
  type ProjectOverviewResponse,
  type ProjectOverviewSection,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { listIdeasWithDerivedStatus } from './idea-list-core';
import type { OperationContext } from './types';

/**
 * Task statuses whose chat can be running: placed but not started, and started. An allowlist
 * (`.claude/rules/79`): a status added later is not running until someone decides it is.
 * `sleeping` is deliberately absent: a sleeping chat is not running.
 */
export const OVERVIEW_STARTING_TASK_STATUSES = ['queued', 'delegated'] as const;
export const OVERVIEW_RUNNING_TASK_STATUSES = [
  ...OVERVIEW_STARTING_TASK_STATUSES,
  'in_progress',
] as const;

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Awake chats (`session_summaries.status = 'active'`, the D1 index the DO keeps in sync) whose
 * task is in a running status, and that are either still being placed, mid-turn
 * (`agent_completed_at IS NULL`, the same rule the chat list uses for "idle"), or paused on an
 * open question. The task join carries `project_id` so a task id cannot reach across projects
 * (rule 11). `COUNT(*) OVER ()` gives the total without a second round trip.
 */
const RUNNING_SQL = `
  SELECT ss.id, ss.task_id, ss.topic, ss.started_at, ss.created_at, ss.last_message_at,
         ss.agent_completed_at, ss.created_by_user_id,
         CASE WHEN ss.attention_json IS NULL THEN 0 ELSE 1 END AS has_attention,
         t.status AS task_status, t.agent_profile_hint,
         ap.name AS profile_name,
         COUNT(*) OVER () AS total
    FROM session_summaries ss
    JOIN tasks t ON t.id = ss.task_id AND t.project_id = ss.project_id
    LEFT JOIN agent_profiles ap
      ON ap.id = t.agent_profile_hint AND (ap.project_id IS NULL OR ap.project_id = ss.project_id)
   WHERE ss.project_id = ?
     AND ss.status = 'active'
     AND t.status IN (${sqlList(OVERVIEW_RUNNING_TASK_STATUSES)})
     AND (
       t.status IN (${sqlList(OVERVIEW_STARTING_TASK_STATUSES)})
       OR ss.attention_json IS NOT NULL
       OR (ss.agent_completed_at IS NULL
           AND (t.execution_step IS NULL OR t.execution_step <> 'awaiting_followup'))
     )
   ORDER BY COALESCE(ss.last_message_at, ss.created_at, ss.started_at) DESC, ss.id DESC
   LIMIT ?`;

const MERGED_PULL_REQUESTS_SQL = `
  SELECT number, url, title, repository, merged_at
    FROM pull_requests
   WHERE project_id = ? AND state = 'merged'
   ORDER BY COALESCE(merged_at, updated_at) DESC, id DESC
   LIMIT ?`;

/** A row read back out of D1 is a trust boundary: validate it, never cast it (rule 51). */
const RunningRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  task_id: v.pipe(v.string(), v.minLength(1)),
  topic: v.nullable(v.string()),
  started_at: v.number(),
  created_at: v.nullable(v.number()),
  last_message_at: v.nullable(v.number()),
  agent_completed_at: v.nullable(v.number()),
  created_by_user_id: v.nullable(v.string()),
  has_attention: v.number(),
  task_status: v.picklist(OVERVIEW_RUNNING_TASK_STATUSES),
  agent_profile_hint: v.nullable(v.string()),
  profile_name: v.nullable(v.string()),
});

const MergedPullRequestRowSchema = v.object({
  number: v.pipe(v.number(), v.integer()),
  url: v.pipe(v.string(), v.url()),
  title: v.nullable(v.string()),
  repository: v.string(),
  merged_at: v.nullable(v.string()),
});

export interface ProjectOverviewInput {
  projectId: string;
  runningLimit?: number;
  recentLimit?: number;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_PROJECT_OVERVIEW_LIMIT, Math.max(1, Math.floor(value)));
}

function toRunningChat(
  row: v.InferOutput<typeof RunningRowSchema>,
  viewerId: string
): OverviewRunningChat {
  const starting = (OVERVIEW_STARTING_TASK_STATUSES as readonly string[]).includes(row.task_status);
  const waiting = !starting && row.has_attention === 1;
  const startedAt = row.created_at ?? row.started_at;
  return {
    sessionId: row.id,
    taskId: row.task_id,
    topic: row.topic,
    state: starting ? 'starting' : waiting ? 'waiting' : 'working',
    // The open question is shown only to the person who started the chat, as the chat list does.
    waitingOnViewer: waiting && row.created_by_user_id === viewerId,
    startedAt,
    lastActivityAt: row.last_message_at ?? startedAt,
    profile:
      row.agent_profile_hint && row.profile_name
        ? { id: row.agent_profile_hint, name: row.profile_name }
        : null,
    createdByUserId: row.created_by_user_id,
  };
}

async function readRunning(
  ctx: OperationContext,
  projectId: string,
  limit: number
): Promise<ProjectOverviewResponse['running']> {
  const result = await ctx.env.DATABASE.prepare(RUNNING_SQL)
    .bind(projectId, limit)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const items: OverviewRunningChat[] = [];
  for (const raw of rows) {
    // One malformed row costs that row, not the section (`apps/api/.claude/rules/50`).
    const parsed = v.safeParse(RunningRowSchema, raw);
    if (!parsed.success) {
      log.error('project_overview.running_row_skipped', {
        projectId,
        sessionId: typeof raw.id === 'string' ? raw.id : null,
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
      continue;
    }
    items.push(toRunningChat(parsed.output, ctx.actor.userId));
  }
  // The window count is the query's, so a skipped row still counts as running.
  const windowTotal = rows[0]?.total;
  const total = typeof windowTotal === 'number' ? windowTotal : rows.length;
  return { items, total: Math.max(total, items.length) };
}

async function readMergedPullRequests(
  ctx: OperationContext,
  projectId: string,
  limit: number
): Promise<OverviewMergedPullRequest[]> {
  const result = await ctx.env.DATABASE.prepare(MERGED_PULL_REQUESTS_SQL)
    .bind(projectId, limit)
    .all<Record<string, unknown>>();
  const items: OverviewMergedPullRequest[] = [];
  for (const raw of result.results ?? []) {
    const parsed = v.safeParse(MergedPullRequestRowSchema, raw);
    if (!parsed.success) {
      log.error('project_overview.pull_request_row_skipped', {
        projectId,
        number: typeof raw.number === 'number' ? raw.number : null,
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
      continue;
    }
    const row = parsed.output;
    items.push({
      number: row.number,
      url: row.url,
      title: row.title,
      repository: row.repository,
      mergedAt: row.merged_at,
    });
  }
  return items;
}

/** The newest ideas, open or closed: the ideas list's own rows, so each carries its state. */
async function readRecentIdeas(
  ctx: OperationContext,
  projectId: string,
  limit: number
): Promise<IdeaListItem[]> {
  const { items } = await listIdeasWithDerivedStatus(ctx, {
    projectId,
    openLimit: limit,
    closedLimit: limit,
  });
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

/**
 * Run one section; a failure leaves that section empty and names it in `unavailable`, so one
 * broken read does not blank the page and the page can say what it could not load.
 */
async function section<T>(
  name: ProjectOverviewSection,
  projectId: string,
  fallback: T,
  read: () => Promise<T>,
  unavailable: ProjectOverviewSection[]
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    log.error('project_overview.section_failed', {
      projectId,
      section: name,
      error: error instanceof Error ? error.message : String(error),
      action: 'section_unavailable',
    });
    unavailable.push(name);
    return fallback;
  }
}

export async function projectOverviewGet(
  ctx: OperationContext,
  input: ProjectOverviewInput
): Promise<ProjectOverviewResponse> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  await authorizeProjectOperation(ctx, projectId);
  const runningLimit = clampLimit(input.runningLimit, DEFAULT_PROJECT_OVERVIEW_RUNNING_LIMIT);
  const recentLimit = clampLimit(input.recentLimit, DEFAULT_PROJECT_OVERVIEW_RECENT_LIMIT);

  const unavailable: ProjectOverviewSection[] = [];
  const [running, ideas, mergedPullRequests] = await Promise.all([
    section(
      'running',
      projectId,
      { items: [], total: 0 },
      () => readRunning(ctx, projectId, runningLimit),
      unavailable
    ),
    section(
      'ideas',
      projectId,
      [],
      () => readRecentIdeas(ctx, projectId, recentLimit),
      unavailable
    ),
    section(
      'pullRequests',
      projectId,
      [],
      () => readMergedPullRequests(ctx, projectId, recentLimit),
      unavailable
    ),
  ]);

  return {
    projectId,
    running,
    recent: { ideas, mergedPullRequests },
    unavailable,
    generatedAt: new Date().toISOString(),
  };
}
