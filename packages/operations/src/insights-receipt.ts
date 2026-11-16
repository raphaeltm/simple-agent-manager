/**
 * Run receipt (Insights slice R): one task-backed run's phases, outcome, account, resources,
 * tool calls and what slowed it down. Shared by REST (`GET .../tasks/:taskId/receipt`), the SAM
 * Connector (catalog operation `sam_run_receipt`) and, with slice I, sam-mcp. Build spec: idea
 * 01M7HTS38KX2G78JD0ESAGMKKH. Arithmetic lives in `insights-receipt-compute.ts`.
 *
 * Round trips (`.claude/rules/60`, receipt budget 8): authorization (1), settings (1, cached per
 * isolate), the task read (1), then in parallel the pull request (≤1), the ProjectData facts
 * (≤1) and the comparable runs (≤1), and the account name for the person who ran it (≤1).
 * At most 7.
 *
 * Scope: every statement binds `project_id` (rule 11). A task in another project and a task that
 * does not exist return the same not-found. Child tables without a project column
 * (`task_status_events`, `agent_sessions`) are reached only through a project-scoped parent.
 */
import { parseStoredResolvedReservationJson } from '@simple-agent-manager/scheduler-core';
import {
  credentialIdFromReference,
  type RunReceipt,
  type RunReceiptAccount,
  type RunReceiptFacts,
  type RunReceiptOutcome,
  type RunReceiptResources,
  type RunReceiptSection,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import {
  type ComparableRun,
  computePhases,
  slowedDown,
  timestampMs,
  type UsualDurations,
  usualDurations,
} from './insights-receipt-compute';
import { getInsightsReceiptLimits, type InsightsReceiptLimits } from './insights-receipt-settings';
import { parseProjectPullRequestUrl } from './pull-request-core';
import type { OperationContext } from './types';

/** Bounds on the JSON sub-selects of the task read; each keeps the statement's size fixed. */
const STATUS_EVENT_LIMIT = 100;
const ASK_LIMIT = 50;
const AGENT_SESSION_LIMIT = 10;
const PR_ASSOCIATION_LIMIT = 5;

/**
 * The task, its workspace and project, and the small child sets the receipt needs, in one
 * statement. Bind order: asks limit, task id, project id.
 */
const TASK_SQL = `
  SELECT t.id, t.title, t.status, t.created_at, t.started_at, t.completed_at, t.terminal_reason,
         t.chat_session_id, t.skill_id, t.agent_profile_hint, t.output_pr_url,
         t.resolved_reservation_json AS task_reservation,
         p.repository AS project_repository,
         w.id AS workspace_id, w.creating_started_at, w.chat_session_id AS workspace_session_id,
         w.resolved_reservation_json AS workspace_reservation,
         (SELECT json_group_array(json_object('to', e.to_status, 'at', e.created_at)) FROM (
            SELECT to_status, created_at FROM task_status_events
             WHERE task_id = t.id ORDER BY created_at, id LIMIT ${STATUS_EVENT_LIMIT}) e) AS status_events,
         (SELECT json_object('rows', COUNT(*), 'memoryPeak', MAX(memory_peak_bytes),
                 'cpuPeak', MAX(cpu_peak_millis), 'oom', COALESCE(SUM(oom_count), 0))
            FROM workspace_resource_summaries r
           WHERE r.project_id = t.project_id AND r.task_id = t.id) AS resources,
         (SELECT json_group_array(json_object('start', a.created_at, 'end', a.resolved_at,
                 'title', a.title)) FROM (
            SELECT created_at, resolved_at, title FROM asks
             WHERE project_id = t.project_id
               AND source_session_id = COALESCE(t.chat_session_id, w.chat_session_id)
               AND (source_task_id IS NULL OR source_task_id = t.id)
             ORDER BY created_at LIMIT ?) a) AS asks,
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

/** Served by `idx_pull_requests_project_repo_number`. */
const PULL_REQUEST_SQL = `
  SELECT pr.number, pr.url, pr.title, pr.repository, pr.state, pr.merged_at, pr.checks_state,
         (SELECT MAX(c.updated_at) FROM pull_request_checks c
           WHERE c.project_id = pr.project_id AND c.repository = pr.repository
             AND c.head_sha = pr.head_sha AND c.state != 'pending') AS last_check_at,
         (SELECT COUNT(*) FROM pull_request_checks c
           WHERE c.project_id = pr.project_id AND c.repository = pr.repository
             AND c.head_sha = pr.head_sha) AS check_count
    FROM pull_requests pr
   WHERE pr.project_id = ? AND pr.repository = ? AND pr.number = ?
   LIMIT 1`;

/**
 * Comparable runs: the same skill (or, without one, the same profile) in this project, recent,
 * with a workspace. Bounded by the window and the run cap; the per-run event lookups use
 * `idx_task_status_events_task_created_at`.
 */
function comparisonSql(column: 'skill_id' | 'agent_profile_hint'): string {
  return `
  SELECT t.created_at, w.creating_started_at,
         (SELECT MIN(e.created_at) FROM task_status_events e
           WHERE e.task_id = t.id AND e.to_status = 'delegated') AS delegated_at,
         (SELECT MIN(e.created_at) FROM task_status_events e
           WHERE e.task_id = t.id AND e.to_status = 'in_progress') AS in_progress_at
    FROM tasks t
    JOIN workspaces w ON w.id = t.workspace_id AND w.project_id = t.project_id
   WHERE t.project_id = ? AND t.${column} = ? AND t.id != ?
     AND t.created_at >= ?
   ORDER BY t.created_at DESC
   LIMIT ?`;
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
  status_events: v.nullish(v.string()),
  resources: v.nullish(v.string()),
  asks: v.nullish(v.string()),
  agent_sessions: v.nullish(v.string()),
  pr_urls: v.nullish(v.string()),
});
type TaskRow = v.InferOutput<typeof TaskRowSchema>;

const StatusEventSchema = v.object({ to: v.string(), at: v.string() });
const AskSchema = v.object({
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
  last_check_at: v.nullish(v.string()),
  check_count: v.number(),
});

/**
 * Parse a JSON array column and validate each element; a malformed element is dropped and
 * logged, never fatal (`.claude/rules/50`). Returns [] for an unreadable column.
 */
function parseJsonList<T>(
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
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
  });
  return items;
}

function firstEventAt(
  events: v.InferOutput<typeof StatusEventSchema>[],
  to: string
): number | null {
  let first: number | null = null;
  for (const event of events) {
    if (event.to !== to) continue;
    const at = timestampMs(event.at);
    if (at !== null && (first === null || at < first)) first = at;
  }
  return first;
}

function earliest(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.min(...known) : null;
}

function reservationOf(row: TaskRow): { memoryMb: number; cpuMillis: number } | null {
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

function readResources(
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

async function readTask(
  ctx: OperationContext,
  projectId: string,
  taskId: string
): Promise<TaskRow | null> {
  const raw = await ctx.env.DATABASE.prepare(TASK_SQL)
    .bind(ASK_LIMIT, taskId, projectId)
    .first<Record<string, unknown>>();
  if (!raw) return null;
  const parsed = v.safeParse(TaskRowSchema, raw);
  if (!parsed.success) {
    // A single-row read that cannot be parsed is a clean not-found, never a 500 (rule 50).
    log.error('insights_receipt.task_row_unreadable', {
      projectId,
      taskId,
      issue: parsed.issues[0]?.message ?? 'invalid row',
      action: 'not_found',
    });
    return null;
  }
  return parsed.output;
}

interface PullRequestRead {
  outcome: Pick<RunReceiptOutcome, 'pullRequest' | 'checks'>;
  finalCheckAt: number | null;
  hasChecks: boolean;
}

async function readPullRequest(
  ctx: OperationContext,
  projectId: string,
  row: TaskRow
): Promise<PullRequestRead> {
  const none: PullRequestRead = {
    outcome: { pullRequest: null, checks: null },
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
      issue: parsed.issues[0]?.message ?? 'invalid row',
      action: 'skipped',
    });
    return none;
  }
  const pr = parsed.output;
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
      checks: pr.check_count > 0 ? (pr.checks_state ?? null) : null,
    },
    finalCheckAt: timestampMs(pr.last_check_at),
    hasChecks: pr.check_count > 0,
  };
}

async function readUsual(
  ctx: OperationContext,
  projectId: string,
  row: TaskRow,
  limits: InsightsReceiptLimits,
  now: number
): Promise<UsualDurations | null> {
  const comparedBy = row.skill_id ? 'skill' : row.agent_profile_hint ? 'profile' : null;
  if (!comparedBy) return null;
  // ISO bound; rows stamped by CURRENT_TIMESTAMP compare within a day of it, which a
  // window measured in days tolerates.
  const since = new Date(now - limits.receiptComparisonWindowDays * 86_400_000).toISOString();
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
    machineReadyAt: earliest(timestampMs(run.creating_started_at), timestampMs(run.delegated_at)),
    agentStartAt: timestampMs(run.in_progress_at),
  }));
  return usualDurations(runs, comparedBy, limits.receiptComparisonMinRuns);
}

async function readAccount(
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

/** Run one part of the receipt; a failure empties that part and names it, not the receipt. */
async function part<T>(
  name: RunReceiptSection,
  context: { projectId: string; taskId: string },
  fallback: T,
  read: () => Promise<T>,
  unavailable: RunReceiptSection[]
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    log.error('insights_receipt.section_failed', {
      ...context,
      section: name,
      error: error instanceof Error ? error.message : String(error),
      action: 'section_unavailable',
    });
    unavailable.push(name);
    return fallback;
  }
}

export interface RunReceiptInput {
  projectId: string;
  taskId: string;
}

export async function runReceipt(
  ctx: OperationContext,
  input: RunReceiptInput
): Promise<RunReceipt> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  await authorizeProjectOperation(ctx, projectId);
  if (!taskId) throw new OperationError('not_found', 'Task not found');

  const [limits, row] = await Promise.all([
    getInsightsReceiptLimits(ctx),
    readTask(ctx, projectId, taskId),
  ]);
  if (!row) throw new OperationError('not_found', 'Task not found');

  const now = Date.now();
  const context = { projectId, taskId };
  const live = !(TASK_TERMINAL_STATUSES as readonly string[]).includes(row.status);
  const events = parseJsonList(row.status_events, StatusEventSchema, {
    taskId,
    column: 'status_events',
  });
  const createdAt = timestampMs(row.created_at) ?? now;
  const machineReadyAt = earliest(
    timestampMs(row.creating_started_at),
    firstEventAt(events, 'delegated')
  );
  const agentStartAt = firstEventAt(events, 'in_progress') ?? timestampMs(row.started_at);
  const completedAt = live ? null : timestampMs(row.completed_at);
  const sessionId = row.chat_session_id ?? row.workspace_session_id ?? null;
  const unavailable: RunReceiptSection[] = [];

  const [pullRequest, facts, usual] = await Promise.all([
    part('outcome', context, null, () => readPullRequest(ctx, projectId, row), unavailable),
    sessionId && agentStartAt !== null
      ? part(
          'toolCalls',
          context,
          null,
          () =>
            ctx.ports.projectData.getRunReceiptFacts(projectId, {
              sessionId,
              fromMs: agentStartAt,
              toMs: completedAt,
              toolScanMaxRows: limits.receiptToolScanMaxRows,
              waitingMaxIntervals: limits.receiptWaitingMaxQuestions,
            }),
          unavailable
        )
      : Promise.resolve(null),
    part(
      'comparison',
      context,
      null,
      () => readUsual(ctx, projectId, row, limits, now),
      unavailable
    ),
  ]);
  const account = await part(
    'account',
    context,
    null,
    () => readAccount(ctx, row, facts),
    unavailable
  );

  const asks = parseJsonList(row.asks, AskSchema, { taskId, column: 'asks' });
  const waiting = [
    ...(facts?.waitingIntervals ?? []),
    ...asks.map((ask) => ({
      startMs: ask.start,
      endMs: ask.end ?? null,
      reason: ask.title ?? null,
    })),
  ];
  const phases = computePhases({
    createdAt,
    machineReadyAt,
    agentStartAt,
    completedAt,
    live,
    lastActivityAt: facts?.lastMessageAt ?? null,
    lastAgentMessageAt: facts?.lastAgentMessageAt ?? null,
    finalCheckAt: pullRequest?.finalCheckAt ?? null,
    hasChecks: pullRequest?.hasChecks ?? false,
    waiting,
    now,
  });
  const resources = readResources(row, reservationOf(row));
  const checks = pullRequest?.outcome.checks ?? null;

  return {
    projectId,
    taskId,
    sessionId,
    title: row.title ?? '',
    status: row.status,
    live,
    createdAt: new Date(createdAt).toISOString(),
    endedAt: new Date(phases.endMs).toISOString(),
    totalMs: phases.totalMs,
    phases: phases.phases,
    outcome: {
      pullRequest: pullRequest?.outcome.pullRequest ?? null,
      checks,
      ciFirstTry: 'not_recorded',
      terminalReason: row.terminal_reason ?? null,
    },
    account,
    resources,
    toolCalls:
      facts && facts.sessionFound && !facts.messagesArchived
        ? {
            total: facts.toolCalls.total,
            byKind: facts.toolCalls.byKind,
            scanLimited: facts.toolCalls.scanLimited,
          }
        : null,
    tokens: { state: 'not_reported' },
    slowedDown: slowedDown(
      {
        phases,
        usual,
        waiting: facts?.waitingIntervals ?? [],
        askTitles: asks.map((ask) => ({
          startMs: ask.start,
          endMs: ask.end ?? null,
          title: ask.title ?? null,
        })),
        checks,
        peakMemoryBytes: resources.peakMemoryBytes,
        requestedMemoryMb: resources.requestedMemoryMb,
        oomKills: resources.oomKills,
      },
      limits
    ),
    unavailable,
    generatedAt: new Date(now).toISOString(),
  };
}
