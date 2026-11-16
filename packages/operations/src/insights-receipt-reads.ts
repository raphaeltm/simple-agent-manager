/**
 * The reads behind the run receipt (`insights-receipt.ts`): one project-scoped D1 statement for
 * the task and its small child sets, the pull request, comparable runs and the account name.
 * Every statement binds the project (rule 11); every row read back is validated, and a malformed
 * one costs only its own part of the receipt (`.claude/rules/50`).
 */
import { parseStoredResolvedReservationJson } from '@simple-agent-manager/scheduler-core';
import {
  credentialIdFromReference,
  type RunReceiptAccount,
  type RunReceiptFacts,
  type RunReceiptOutcome,
  type RunReceiptResources,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import {
  FIRST_TRY_FAILED_SQL,
  FIRST_TRY_PASSED_SQL,
  FIRST_TRY_PENDING_SQL,
  firstTryVerdictSql,
} from './insights-flow-sql';
import {
  type ComparableRun,
  timestampMs,
  type UsualDurations,
  usualDurations,
} from './insights-receipt-compute';
import type { InsightsReceiptLimits } from './insights-receipt-settings';
import { parseProjectPullRequestUrl } from './pull-request-core';
import type { OperationContext } from './types';

/**
 * Fixed shape bounds on the JSON sub-selects of the task read. They bound how many rows of a
 * one-to-few relation one statement returns (a workspace's agent restarts, a task's owned pull
 * requests), not a tunable budget; the ask cap, which is one, comes from
 * `insights.receiptWaitingMaxQuestions`.
 */
const AGENT_SESSION_LIMIT = 10;
const PR_ASSOCIATION_LIMIT = 5;

/**
 * First time a task entered a status, as a Julian day number. `task_status_events.created_at` is
 * written both as ISO and as `CURRENT_TIMESTAMP` text, which do not compare as strings;
 * `julianday()` reads both. Served by `idx_task_status_events_task_created_at`.
 */
function FIRST_EVENT_JD_SQL(status: 'delegated' | 'in_progress', taskColumn: string): string {
  return `(SELECT MIN(julianday(e.created_at)) FROM task_status_events e
            WHERE e.task_id = ${taskColumn} AND e.to_status = '${status}')`;
}

/**
 * The task, its workspace and project, and the small child sets the receipt needs, in one
 * statement. Bind order: viewer id twice (ask title visibility), asks limit, task id, project id.
 */
const TASK_SQL = `
  SELECT t.id, t.title, t.status, t.created_at, t.started_at, t.completed_at, t.terminal_reason,
         t.chat_session_id, t.skill_id, t.agent_profile_hint, t.output_pr_url,
         t.resolved_reservation_json AS task_reservation,
         p.repository AS project_repository,
         w.id AS workspace_id, w.creating_started_at, w.chat_session_id AS workspace_session_id,
         w.resolved_reservation_json AS workspace_reservation,
         ${FIRST_EVENT_JD_SQL('delegated', 't.id')} AS delegated_jd,
         ${FIRST_EVENT_JD_SQL('in_progress', 't.id')} AS in_progress_jd,
         (SELECT json_object('rows', COUNT(*), 'memoryPeak', MAX(memory_peak_bytes),
                 'cpuPeak', MAX(cpu_peak_millis), 'oom', COALESCE(SUM(oom_count), 0))
            FROM workspace_resource_summaries r
           WHERE r.project_id = t.project_id AND r.task_id = t.id) AS resources,
         (SELECT json_group_array(json_object('start', a.created_at, 'end', a.resolved_at,
                 'title', a.title)) FROM (
            -- Every ask's time counts toward waiting; its title is shown only to the people the
            -- inbox shows it to (inbox-item-core.ts): the assignee, or anyone for an unclaimed
            -- team ask, or its claimant.
            SELECT created_at, resolved_at,
                   CASE WHEN (assignee_kind = 'user' AND assignee_user_id = ?)
                          OR (assignee_kind = 'team'
                              AND (claimed_by_user_id IS NULL OR claimed_by_user_id = ?))
                        THEN title END AS title
              FROM asks
             -- "+project_id" keeps the scope check as a filter so the planner uses
             -- idx_asks_session_status (one chat's asks), never the project's whole ask list.
             WHERE +project_id = t.project_id
               AND source_session_id = COALESCE(t.chat_session_id, w.chat_session_id)
               AND (source_task_id IS NULL OR source_task_id = t.id)
               -- Only this run's asks, so a chat reused across runs keeps each run's own inside
               -- the cap. strftime('%s') reads both ISO and CURRENT_TIMESTAMP task times.
               AND created_at >= CAST(strftime('%s', t.created_at) AS INTEGER) * 1000
               AND (t.completed_at IS NULL
                    OR created_at <= CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000)
             -- Newest first: a chat reused across runs keeps this run's asks inside the cap.
             ORDER BY created_at DESC LIMIT ?) a) AS asks,
         (SELECT json_group_array(json_object('id', s.id, 'userId', s.user_id,
                 'agentType', s.agent_type, 'source', s.agent_credential_source,
                 'scope', s.agent_credential_scope, 'reference', s.agent_credential_reference)) FROM (
            SELECT * FROM agent_sessions WHERE workspace_id = w.id
             ORDER BY created_at DESC, id DESC LIMIT ${AGENT_SESSION_LIMIT}) s) AS agent_sessions,
         (SELECT json_group_array(pr_url) FROM (
            SELECT pr_url FROM task_pull_request_associations
             WHERE task_id = t.id AND project_id = t.project_id AND disposition = 'owned'
             ORDER BY created_at DESC LIMIT ${PR_ASSOCIATION_LIMIT})) AS pr_urls
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN workspaces w ON w.id = t.workspace_id AND w.project_id = t.project_id
   WHERE t.id = ? AND t.project_id = ?
   LIMIT 1`;

/**
 * Served by `idx_pull_requests_project_repo_number`; the checks sub-select reads one head's
 * rows by the `pull_request_checks` primary key prefix, once.
 */
const PULL_REQUEST_SQL = `
  SELECT pr.number, pr.url, pr.title, pr.repository, pr.state, pr.merged_at, pr.checks_state,
         (SELECT json_object('count', COUNT(*),
                 'last', MAX(CASE WHEN c.state != 'pending' THEN c.updated_at END))
            FROM pull_request_checks c
           WHERE c.project_id = pr.project_id AND c.repository = pr.repository
             AND c.head_sha = pr.head_sha) AS checks,
         -- The opening commit's verdict; NULL (not recorded) when SAM has no from_open head.
         -- Served by the pull_request_heads primary key prefix and the checks primary key.
         (SELECT CASE WHEN count(h.head_sha) = 0 THEN NULL ELSE ${firstTryVerdictSql({
           failed: FIRST_TRY_FAILED_SQL,
           passed: FIRST_TRY_PASSED_SQL,
           pending: FIRST_TRY_PENDING_SQL,
           movedOn: "(pr.state <> 'open' OR pr.head_sha IS NOT h.head_sha)",
         })} END
            FROM pull_request_heads h
            LEFT JOIN pull_request_checks c
              ON c.project_id = h.project_id AND c.repository = h.repository
             AND c.head_sha = h.head_sha
           WHERE h.project_id = pr.project_id AND h.repository = pr.repository
             AND h.pr_number = pr.number AND h.from_open = 1) AS first_try
    FROM pull_requests pr
   WHERE pr.project_id = ? AND pr.repository = ? AND pr.number = ?
   LIMIT 1`;

/**
 * Comparable runs: the same skill (or, without one, the same profile) in this project, recent,
 * with a workspace. Bounded by the window and the run cap; the per-run event lookups use
 * `idx_task_status_events_task_created_at`.
 */
function comparisonSql(column: 'skill_id' | 'agent_profile_hint'): string {
  // The inner query is served by idx_tasks_project_skill_created / _profile_created (migration
  // 0252) and stops at the run cap; the event lookups then run for those rows only.
  return `
  SELECT r.created_at, r.creating_started_at,
         ${FIRST_EVENT_JD_SQL('delegated', 'r.id')} AS delegated_jd,
         ${FIRST_EVENT_JD_SQL('in_progress', 'r.id')} AS in_progress_jd
    FROM (
      SELECT t.id, t.created_at, w.creating_started_at
        FROM tasks t
        JOIN workspaces w ON w.id = t.workspace_id AND w.project_id = t.project_id
       WHERE t.project_id = ? AND t.${column} = ? AND t.id != ? AND t.created_at >= ?
       ORDER BY t.created_at DESC
       LIMIT ?
    ) r`;
}

const TaskRowSchema = v.object({
  id: v.string(),
  title: v.nullish(v.string()),
  status: v.string(),
  created_at: v.string(),
  started_at: v.nullish(v.string()),
  completed_at: v.nullish(v.string()),
  terminal_reason: v.nullish(v.string()),
  chat_session_id: v.nullish(v.string()),
  skill_id: v.nullish(v.string()),
  agent_profile_hint: v.nullish(v.string()),
  output_pr_url: v.nullish(v.string()),
  task_reservation: v.nullish(v.string()),
  project_repository: v.string(),
  workspace_id: v.nullish(v.string()),
  creating_started_at: v.nullish(v.string()),
  workspace_session_id: v.nullish(v.string()),
  workspace_reservation: v.nullish(v.string()),
  delegated_jd: v.nullish(v.number()),
  in_progress_jd: v.nullish(v.number()),
  resources: v.nullish(v.string()),
  asks: v.nullish(v.string()),
  agent_sessions: v.nullish(v.string()),
  pr_urls: v.nullish(v.string()),
});
export type TaskRow = v.InferOutput<typeof TaskRowSchema>;

export const AskSchema = v.object({
  start: v.number(),
  end: v.nullish(v.number()),
  title: v.nullish(v.string()),
});
const AgentSessionSchema = v.object({
  id: v.string(),
  userId: v.string(),
  agentType: v.nullish(v.string()),
  source: v.nullish(v.string()),
  scope: v.nullish(v.string()),
  reference: v.nullish(v.string()),
});
const ResourcesSchema = v.object({
  rows: v.number(),
  memoryPeak: v.nullish(v.number()),
  cpuPeak: v.nullish(v.number()),
  oom: v.nullish(v.number()),
});
const PullRequestRowSchema = v.object({
  number: v.pipe(v.number(), v.integer()),
  url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\//i)),
  title: v.nullish(v.string()),
  repository: v.string(),
  state: v.picklist(['open', 'closed', 'merged']),
  merged_at: v.nullish(v.string()),
  checks_state: v.nullish(v.picklist(['pending', 'success', 'failure', 'neutral'])),
  checks: v.nullish(v.string()),
  first_try: v.nullish(v.picklist(['passed', 'failed', 'pending'])),
});

const ChecksSchema = v.object({ count: v.number(), last: v.nullish(v.string()) });

/**
 * Where a row failed validation, for the log. The key, not valibot's message: the message quotes
 * the offending value, and that can be a task title or a question from another person.
 */
function issuePath(issue: v.BaseIssue<unknown> | undefined): string {
  const path = issue?.path?.map((item) => String(item.key)).join('.');
  return path ? `invalid ${path}` : 'invalid row';
}

/**
 * Parse a JSON array column and validate each element; a malformed element is dropped and
 * logged, never fatal (`.claude/rules/50`). Returns [] for an unreadable column.
 */
export function parseJsonList<T>(
  raw: string | null | undefined,
  schema: v.GenericSchema<unknown, T>,
  context: { taskId: string; column: string }
): T[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    log.warn('insights_receipt.column_unreadable', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      action: 'skipped',
    });
    return [];
  }
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  value.forEach((element, index) => {
    const parsed = v.safeParse(schema, element);
    if (parsed.success) items.push(parsed.output);
    else
      log.warn('insights_receipt.row_skipped', {
        ...context,
        index,
        issue: issuePath(parsed.issues[0]),
        action: 'skipped',
      });
  });
  return items;
}

/** A Julian day number from SQLite's `julianday()` as epoch milliseconds. */
export function julianDayMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round((value - 2_440_587.5) * 86_400_000);
}

export function earliest(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.min(...known) : null;
}

export function reservationOf(row: TaskRow): { memoryMb: number; cpuMillis: number } | null {
  for (const raw of [row.workspace_reservation, row.task_reservation]) {
    try {
      const parsed = parseStoredResolvedReservationJson(raw);
      if (parsed) return { memoryMb: parsed.memoryMb, cpuMillis: parsed.cpuMillis };
    } catch (error) {
      log.warn('insights_receipt.reservation_skipped', {
        taskId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

export function readResources(
  row: TaskRow,
  reservation: ReturnType<typeof reservationOf>
): RunReceiptResources {
  let summary: v.InferOutput<typeof ResourcesSchema> | null = null;
  try {
    const parsed = v.safeParse(
      ResourcesSchema,
      row.resources ? (JSON.parse(row.resources) as unknown) : null
    );
    summary = parsed.success ? parsed.output : null;
  } catch {
    summary = null;
  }
  return {
    measured: (summary?.rows ?? 0) > 0,
    peakMemoryBytes: summary?.memoryPeak ?? null,
    requestedMemoryMb: reservation?.memoryMb ?? null,
    peakCpuMillis: summary?.cpuPeak ?? null,
    requestedCpuMillis: reservation?.cpuMillis ?? null,
    oomKills: summary?.oom ?? 0,
  };
}

export async function readTask(
  ctx: OperationContext,
  projectId: string,
  taskId: string,
  /** Most asks read; one more is fetched so a cut-off list can say so. */
  askLimit: number
): Promise<TaskRow | null> {
  const raw = await ctx.env.DATABASE.prepare(TASK_SQL)
    .bind(ctx.actor.userId, ctx.actor.userId, askLimit + 1, taskId, projectId)
    .first<Record<string, unknown>>();
  if (!raw) return null;
  const parsed = v.safeParse(TaskRowSchema, raw);
  if (!parsed.success) {
    // A single-row read that cannot be parsed is a clean not-found, never a 500 (rule 50).
    log.error('insights_receipt.task_row_unreadable', {
      projectId,
      taskId,
      issue: issuePath(parsed.issues[0]),
      action: 'not_found',
    });
    return null;
  }
  return parsed.output;
}

export interface PullRequestRead {
  outcome: Pick<RunReceiptOutcome, 'pullRequest' | 'checks' | 'ciFirstTry'>;
  finalCheckAt: number | null;
  hasChecks: boolean;
}

export async function readPullRequest(
  ctx: OperationContext,
  projectId: string,
  row: TaskRow
): Promise<PullRequestRead> {
  const none: PullRequestRead = {
    outcome: { pullRequest: null, checks: null, ciFirstTry: 'not_recorded' },
    finalCheckAt: null,
    hasChecks: false,
  };
  const candidates = [
    row.output_pr_url,
    ...parseJsonList(row.pr_urls, v.string(), { taskId: row.id, column: 'pr_urls' }),
  ];
  const target = candidates
    .map((url) => (url ? parseProjectPullRequestUrl(url, row.project_repository) : null))
    .find((parsed) => parsed !== null);
  if (!target) return none;
  const raw = await ctx.env.DATABASE.prepare(PULL_REQUEST_SQL)
    .bind(projectId, target.repository, target.number)
    .first<Record<string, unknown>>();
  if (!raw) return none;
  const parsed = v.safeParse(PullRequestRowSchema, raw);
  if (!parsed.success) {
    log.warn('insights_receipt.pull_request_skipped', {
      projectId,
      taskId: row.id,
      issue: issuePath(parsed.issues[0]),
      action: 'skipped',
    });
    return none;
  }
  const pr = parsed.output;
  let checks: v.InferOutput<typeof ChecksSchema> | null = null;
  try {
    const parsedChecks = v.safeParse(
      ChecksSchema,
      pr.checks ? (JSON.parse(pr.checks) as unknown) : null
    );
    checks = parsedChecks.success ? parsedChecks.output : null;
  } catch {
    checks = null;
  }
  const checkCount = checks?.count ?? 0;
  return {
    outcome: {
      pullRequest: {
        number: pr.number,
        url: pr.url,
        title: pr.title ?? null,
        repository: pr.repository,
        state: pr.state,
        mergedAt: pr.merged_at ?? null,
      },
      checks: checkCount > 0 ? (pr.checks_state ?? null) : null,
      ciFirstTry: pr.first_try ?? 'not_recorded',
    },
    finalCheckAt: timestampMs(checks?.last),
    hasChecks: checkCount > 0,
  };
}

export async function readUsual(
  ctx: OperationContext,
  projectId: string,
  row: TaskRow,
  limits: InsightsReceiptLimits,
  now: number
): Promise<UsualDurations | null> {
  const comparedBy = row.skill_id ? 'skill' : row.agent_profile_hint ? 'profile' : null;
  if (!comparedBy) return null;
  // The date alone ("YYYY-MM-DD"): `tasks.created_at` holds both ISO and CURRENT_TIMESTAMP
  // text, which differ at the 11th character, and a date prefix sorts correctly against both.
  // The window therefore starts at the beginning of its first day.
  const since = new Date(now - limits.receiptComparisonWindowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const result = await ctx.env.DATABASE.prepare(
    comparisonSql(comparedBy === 'skill' ? 'skill_id' : 'agent_profile_hint')
  )
    .bind(
      projectId,
      comparedBy === 'skill' ? row.skill_id : row.agent_profile_hint,
      row.id,
      since,
      limits.receiptComparisonRuns
    )
    .all<Record<string, unknown>>();
  const runs: ComparableRun[] = (result.results ?? []).map((run) => ({
    createdAt: timestampMs(run.created_at),
    machineReadyAt: earliest(timestampMs(run.creating_started_at), julianDayMs(run.delegated_jd)),
    agentStartAt: julianDayMs(run.in_progress_jd),
  }));
  return usualDurations(runs, comparedBy, limits.receiptComparisonMinRuns);
}

export async function readAccount(
  ctx: OperationContext,
  row: TaskRow,
  facts: RunReceiptFacts | null
): Promise<RunReceiptAccount | null> {
  const sessions = parseJsonList(row.agent_sessions, AgentSessionSchema, {
    taskId: row.id,
    column: 'agent_sessions',
  });
  // The chat's own ACP session is canonical (`acp_sessions.chat_session_id`); the workspace's
  // newest session that recorded an account is the fallback when the facts are unavailable.
  const canonical = facts?.acpSessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .find((session) => session?.reference);
  const chosen = canonical ?? sessions.find((session) => session.reference) ?? sessions[0];
  if (!chosen) return null;
  const isOwnSession = chosen.userId === ctx.actor.userId;
  let accountName: string | null = null;
  const credentialId = chosen.reference ? credentialIdFromReference(chosen.reference) : null;
  // Account names are private to the person who ran the session (`routes/chat-agent-credential.ts`).
  if (isOwnSession && credentialId) {
    const stored = await ctx.env.DATABASE.prepare(
      'SELECT name FROM cc_credentials WHERE id = ? AND owner_id = ? LIMIT 1'
    )
      .bind(credentialId, ctx.actor.userId)
      .first<{ name: unknown }>();
    accountName = typeof stored?.name === 'string' ? stored.name : null;
  }
  return {
    agentType: chosen.agentType ?? null,
    credentialSource: chosen.source ?? null,
    credentialScope: chosen.scope ?? null,
    accountName,
    isOwnSession,
  };
}
