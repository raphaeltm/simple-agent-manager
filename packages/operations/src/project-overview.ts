/**
 * The Project Overview's one aggregated read (Inbox slice F1, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9,
 * section 4.2): what is running in a project and what happened recently.
 *
 * Budgets and Automations are not here on purpose. Their rules (which account a profile runs on,
 * when an automation needs attention) live in the web app's shared models, and the page reuses
 * those models and their cached reads rather than restating the rules on the server.
 *
 * Round trips: authorization (1, the access port's membership read), then in parallel the
 * running query (2: the ProjectData read of which chats are mid-turn, then one statement), the
 * merged pull requests (1) and the recent ideas (`listRecentIdeasWithDerivedStatus`: rows,
 * repository, the ProjectData snapshot, and up to four evidence reads, so at most 7), and the
 * brief (1: its stored row and which of the items it names are still open, one statement; it
 * shares the running query's ProjectData read; settings are cached per isolate). About 12, within the 20 a
 * dashboard read may spend (`.claude/rules/60`). The brief is only read here: making one runs
 * after the response, in the background (`refreshProjectBriefIfDue`, apps/api).
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
import { listRecentIdeasWithDerivedStatus } from './idea-list-core';
import { readProjectBrief } from './project-brief-read';
import { getProjectBriefSettings } from './project-brief-settings';
import {
  OVERVIEW_RUNNING_TASK_STATUSES,
  OVERVIEW_STARTING_TASK_STATUSES,
  OVERVIEW_WORKING_SESSIONS_SQL,
  overviewChatRunningSql,
  overviewPausedSessionsSql,
} from './project-overview-statuses';
import type { OperationContext } from './types';

export { OVERVIEW_RUNNING_TASK_STATUSES, OVERVIEW_STARTING_TASK_STATUSES };

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * The chat is paused on a person: a ProjectData attention marker (synced to
 * `session_summaries.attention_json`), an open question held in D1 `asks` (inbox slice G), or a
 * pending secret request from the chat. The inbox lists each of these as a blocking item
 * ("paused on this", `inboxAgentState`), so Running now keeps the chat too instead of dropping it
 * when its turn ends (inbox slice F2: the two sections must not contradict each other).
 * `paused_sessions` is the CTE at the head of `RUNNING_SQL`.
 */
const PAUSED_ON_PERSON_SQL = `(ss.attention_json IS NOT NULL
      OR ss.id IN (SELECT session_id FROM paused_sessions))`;

/**
 * 1 for a chat paused on a question the viewer must answer (they started it, it is past
 * starting), else 0. Ranked first so the cap can never hide the one exception the page exists to
 * surface (`apps/api/.claude/rules/65`), and summed so the page can say how many there are.
 * Binds the viewer id; it appears twice in `RUNNING_SQL` (the sum and the ranking).
 */
const WAITING_ON_VIEWER_SQL = `(CASE WHEN ${PAUSED_ON_PERSON_SQL} AND ss.created_by_user_id = ?
      AND t.status NOT IN (${sqlList(OVERVIEW_STARTING_TASK_STATUSES)}) THEN 1 ELSE 0 END)`;

/**
 * Awake chats (`session_summaries.status = 'active'`, the D1 index the DO keeps in sync) whose
 * task is in a running status, and that are either still being placed, mid-turn (the ids in
 * `working_sessions`, read from the ProjectData activity mirror), or paused on an open question.
 * The task join carries `project_id` so a task id cannot reach across projects (rule 11), and a
 * profile name is shown only for this project's profiles or the task creator's own global ones,
 * so a hint naming someone else's global profile reveals nothing. `COUNT(*) OVER ()` gives the
 * total without a second round trip. `paused_sessions` reads this project's open, unexpired
 * question asks (`idx_asks_open_question`) and its pending, unexpired secret requests
 * (`idx_runtime_secret_requests_status_expires`; few are ever pending) once, both bound to the
 * project like every other predicate here.
 */
const RUNNING_SQL = `
  WITH paused_sessions AS (
    ${overviewPausedSessionsSql('?')}
  ), working_sessions AS (
    ${OVERVIEW_WORKING_SESSIONS_SQL}
  )
  SELECT ss.id, ss.task_id, ss.topic, ss.started_at, ss.created_at, ss.last_message_at,
         ss.created_by_user_id,
         CASE WHEN ${PAUSED_ON_PERSON_SQL} THEN 1 ELSE 0 END AS has_attention,
         t.status AS task_status, t.agent_profile_hint,
         ap.name AS profile_name,
         COUNT(*) OVER () AS total,
         SUM(${WAITING_ON_VIEWER_SQL}) OVER () AS waiting_on_viewer_total
    FROM session_summaries ss
    JOIN tasks t ON t.id = ss.task_id AND t.project_id = ss.project_id
    LEFT JOIN agent_profiles ap
      ON ap.id = t.agent_profile_hint
     AND (ap.project_id = ss.project_id OR (ap.project_id IS NULL AND ap.user_id = t.user_id))
   WHERE ss.project_id = ?
     AND ${overviewChatRunningSql(
       'SELECT session_id FROM paused_sessions',
       'SELECT session_id FROM working_sessions'
     )}
   ORDER BY ${WAITING_ON_VIEWER_SQL} DESC,
            COALESCE(ss.last_message_at, ss.created_at, ss.started_at) DESC, ss.id DESC
   LIMIT ?`;

/** Served by `idx_pull_requests_project_state_merged` (migration 0249): no scan of the project's history. */
const MERGED_PULL_REQUESTS_SQL = `
  SELECT number, url, title, repository, merged_at
    FROM pull_requests
   WHERE project_id = ? AND state = 'merged'
   ORDER BY merged_at DESC
   LIMIT ?`;

/** A row read back out of D1 is a trust boundary: validate it, never cast it (rule 51). */
const RunningRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  task_id: v.pipe(v.string(), v.minLength(1)),
  topic: v.nullable(v.string()),
  started_at: v.number(),
  created_at: v.nullable(v.number()),
  last_message_at: v.nullable(v.number()),
  created_by_user_id: v.nullable(v.string()),
  has_attention: v.number(),
  task_status: v.picklist(OVERVIEW_RUNNING_TASK_STATUSES),
  agent_profile_hint: v.nullable(v.string()),
  profile_name: v.nullable(v.string()),
});

const MergedPullRequestRowSchema = v.object({
  number: v.pipe(v.number(), v.integer()),
  // Rendered as a link: only https (the writers already store canonical GitHub URLs; this keeps
  // a stray `javascript:` or `data:` value from ever reaching an href).
  url: v.pipe(v.string(), v.url(), v.regex(/^https:\/\//i)),
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

/**
 * Running now for one viewer. `viewerId` only decides which rows are "waiting on the viewer" (and
 * ranks them first); pass an id that matches nobody for a viewer-neutral read, as the brief's
 * facts do (`project-brief-facts.ts`). `workingSessionIds` are the chats whose agent is mid-turn,
 * from the ProjectData object (`listWorkingChatSessionIds`).
 */
export async function readRunningChats(
  db: D1Database,
  projectId: string,
  viewerId: string,
  limit: number,
  workingSessionIds: readonly string[]
): Promise<ProjectOverviewResponse['running']> {
  const now = Date.now();
  const result = await db
    .prepare(RUNNING_SQL)
    // Placeholders in order: project and clock (open questions), project and clock (pending
    // secret requests), working chat ids (JSON), viewer (sum), project, viewer (ranking), limit.
    .bind(
      projectId,
      now,
      projectId,
      now,
      JSON.stringify(workingSessionIds),
      viewerId,
      projectId,
      viewerId,
      limit
    )
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
    items.push(toRunningChat(parsed.output, viewerId));
  }
  // The window count is the query's, so a skipped row still counts as running.
  const windowTotal = rows[0]?.total;
  const total = typeof windowTotal === 'number' ? windowTotal : rows.length;
  const waitingTotal = rows[0]?.waiting_on_viewer_total;
  const shownWaiting = items.filter((item) => item.waitingOnViewer).length;
  return {
    items,
    total: Math.max(total, items.length),
    waitingOnViewerTotal: Math.max(
      typeof waitingTotal === 'number' ? waitingTotal : 0,
      shownWaiting
    ),
  };
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

/** The newest ideas, open or closed: the Ideas list's own item shape, so each carries its state. */
function readRecentIdeas(
  ctx: OperationContext,
  projectId: string,
  limit: number
): Promise<IdeaListItem[]> {
  return listRecentIdeasWithDerivedStatus(ctx, { projectId, limit });
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

/**
 * Run a read once the mid-turn ids are known, so its clock is taken after that wait, the same
 * side of an ask's expiry as Running now's own clock (`readRunningChats`).
 */
async function readBriefAfter<T>(
  working: Promise<string[]>,
  read: (ids: string[]) => Promise<T>
): Promise<T> {
  return read(await working);
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
  // Read once, used by Running now and by the brief's re-check of the chats it names. If it
  // fails, both sections are unavailable rather than reporting every chat as idle.
  // `then`: a port that throws synchronously still becomes a rejection the sections catch.
  const working = Promise.resolve().then(() =>
    ctx.ports.projectData.listWorkingChatSessionIds(projectId)
  );
  working.catch(() => undefined); // Each section reports its own failure.
  const [running, ideas, mergedPullRequests, brief] = await Promise.all([
    section(
      'running',
      projectId,
      { items: [], total: 0, waitingOnViewerTotal: 0 },
      async () =>
        readRunningChats(
          ctx.env.DATABASE,
          projectId,
          ctx.actor.userId,
          runningLimit,
          await working
        ),
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
    // The brief (inbox slice I): switched off means no read at all. Settings are cached per
    // isolate, so this section costs one D1 statement.
    section(
      'brief',
      projectId,
      null,
      async () =>
        (await getProjectBriefSettings(ctx)).enabled
          ? await readBriefAfter(working, (ids) =>
              readProjectBrief(ctx.env.DATABASE, projectId, Date.now(), ids)
            )
          : null,
      unavailable
    ),
  ]);

  return {
    projectId,
    running,
    recent: { ideas, mergedPullRequests },
    brief,
    unavailable,
    generatedAt: new Date().toISOString(),
  };
}
