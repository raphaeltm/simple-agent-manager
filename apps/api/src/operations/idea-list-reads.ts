/**
 * The D1 reads and row shaping behind the Ideas list and the idea page.
 *
 * Split out of `idea-list-core.ts` so the aggregation reads as one story: every function here
 * is one batched query plus the plain-data mapping of its rows. Nothing here derives state.
 */
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { ideaTaskPredicateSql } from './idea-core';
import { IDEA_OPEN_STATUSES } from './idea-transitions';
import type { OperationContext } from './types';

/** How many open ideas one page carries. The side columns are capped more tightly. */
export const DEFAULT_IDEA_LIST_OPEN_LIMIT = 100;
/** How many finished or parked ideas the "Done recently" group carries. */
export const DEFAULT_IDEA_LIST_CLOSED_LIMIT = 20;
/** How much of the plan travels with a list row as its one-line summary. */
export const DEFAULT_IDEA_SUMMARY_MAX_LENGTH = 180;

/**
 * The platform's bound-parameter ceiling covers the whole statement, not just the `IN (…)`
 * list. The widest query here binds one project id beside the list; the margin is wider than
 * that so another predicate can be added without silently crossing the ceiling.
 */
const RESERVED_BIND_PARAMETERS = 4;
const MAX_IDS_PER_QUERY = D1_MAX_BOUND_PARAMETERS - RESERVED_BIND_PARAMETERS;

export interface IdeaRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  triggered_by: string | null;
  connector_client_name: string | null;
  idea_merge_ack_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * When the idea was marked done, written by `applyIdeaStatusTransition` at the moment of the
   * transition and cleared again on reopen. A real transition clock, unlike `updated_at`,
   * which any later edit to the plan moves.
   */
  completed_at: string | null;
}

export interface SessionTaskRow {
  id: string;
  status: string;
  error_message: string | null;
  output_pr_url: string | null;
  agent_profile_hint: string | null;
}

export interface IdeaListTotals {
  open: number;
  done: number;
  parked: number;
}

const IDEA_COLUMNS =
  'id, title, description, status, triggered_by, connector_client_name, idea_merge_ack_at, created_at, updated_at, completed_at';

export { IDEA_COLUMNS };

/**
 * An idea filed by an automation or an incident rather than typed by a person. `triggered_by`
 * is `'user'` for anything a person created and `'connector'` for a connected client acting
 * on their behalf; everything else is a trigger or the platform's own incident pipeline.
 */
export function filedByAgent(row: IdeaRow): boolean {
  const triggeredBy = row.triggered_by ?? 'user';
  return triggeredBy !== 'user' && triggeredBy !== 'connector';
}

export function filedByLabel(row: IdeaRow): string | null {
  if (!filedByAgent(row)) return null;
  return row.connector_client_name ?? row.triggered_by ?? null;
}

/** The connected client a person filed this idea through, when they used one. */
export function viaConnector(row: IdeaRow): string | null {
  if (row.triggered_by !== 'connector') return null;
  return row.connector_client_name ?? 'Connector';
}

/**
 * The opening of the plan, as one line. Markdown headings, list markers and emphasis are
 * dropped so the row reads as a sentence rather than as syntax.
 */
export function ideaSummary(
  content: string | null,
  max = DEFAULT_IDEA_SUMMARY_MAX_LENGTH
): string | null {
  if (!content) return null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}[-*+]\s+/, '')
      .replace(/^\s{0,3}\d+[.)]\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/[*_`]/g, '')
      .trim();
    if (!line) continue;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return null;
}

export async function readIdeaRows(
  ctx: OperationContext,
  projectId: string,
  open: boolean,
  limit: number
): Promise<IdeaRow[]> {
  const statuses = open ? IDEA_OPEN_STATUSES : ['completed', 'cancelled'];
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await ctx.env.DATABASE.prepare(
    `SELECT ${IDEA_COLUMNS} FROM tasks
      WHERE project_id = ? AND ${ideaTaskPredicateSql()} AND status IN (${placeholders})
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`
  )
    .bind(projectId, ...statuses, limit + 1)
    .all<IdeaRow>();
  return result.results ?? [];
}

export async function readIdeaRow(
  ctx: OperationContext,
  projectId: string,
  ideaId: string
): Promise<IdeaRow | null> {
  // Project scope is in the lookup itself, not only on the route, and a task that is not an
  // idea is reported the same way as a missing one (rule 11).
  return ctx.env.DATABASE.prepare(
    `SELECT ${IDEA_COLUMNS} FROM tasks WHERE id = ? AND project_id = ? AND ${ideaTaskPredicateSql()}`
  )
    .bind(ideaId, projectId)
    .first<IdeaRow>();
}

export async function readIdeaTotals(
  ctx: OperationContext,
  projectId: string
): Promise<IdeaListTotals> {
  const result = await ctx.env.DATABASE.prepare(
    `SELECT status, COUNT(*) AS count FROM tasks
      WHERE project_id = ? AND ${ideaTaskPredicateSql()}
      GROUP BY status`
  )
    .bind(projectId)
    .all<{ status: string; count: number }>();
  const totals: IdeaListTotals = { open: 0, done: 0, parked: 0 };
  for (const row of result.results ?? []) {
    if (row.status === 'completed') totals.done += row.count;
    else if (row.status === 'cancelled') totals.parked += row.count;
    else totals.open += row.count;
  }
  return totals;
}

export async function readSessionTasks(
  ctx: OperationContext,
  projectId: string,
  taskIds: readonly string[]
): Promise<Map<string, SessionTaskRow>> {
  const byId = new Map<string, SessionTaskRow>();
  for (const ids of chunk([...new Set(taskIds)], MAX_IDS_PER_QUERY)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await ctx.env.DATABASE.prepare(
      `SELECT id, status, error_message, output_pr_url, agent_profile_hint FROM tasks
        WHERE project_id = ? AND id IN (${placeholders})`
    )
      .bind(projectId, ...ids)
      .all<SessionTaskRow>();
    for (const row of result.results ?? []) byId.set(row.id, row);
  }
  return byId;
}

/**
 * The session tasks AND the pull requests associated with them, in one query.
 *
 * These were two reads over the same ids, the same project and the same chunking — one of
 * `tasks`, one of `task_pull_request_associations` — which cost two D1 round trips on a route
 * the idea page polls (rule 60). A LEFT JOIN answers both, so a task with no association still
 * comes back, with a null `pr_url` that is simply not collected.
 *
 * The join repeats the task columns once per association, which is why the task row is only
 * taken the first time an id is seen. Associations per task are a handful, so the row
 * multiplication is bounded; the bind count is unchanged (one project id plus the chunk), so
 * the D1 parameter ceiling is no closer than it was.
 */
export async function readSessionTasksWithPullRequests(
  ctx: OperationContext,
  projectId: string,
  taskIds: readonly string[]
): Promise<{ tasks: Map<string, SessionTaskRow>; pullRequests: Map<string, string[]> }> {
  const tasks = new Map<string, SessionTaskRow>();
  const pullRequests = new Map<string, string[]>();
  for (const ids of chunk([...new Set(taskIds)], MAX_IDS_PER_QUERY)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await ctx.env.DATABASE.prepare(
      `SELECT t.id, t.status, t.error_message, t.output_pr_url, t.agent_profile_hint,
              a.pr_url AS associated_pr_url
         FROM tasks t
         LEFT JOIN task_pull_request_associations a
           ON a.task_id = t.id AND a.project_id = t.project_id
        WHERE t.project_id = ? AND t.id IN (${placeholders})`
    )
      .bind(projectId, ...ids)
      .all<SessionTaskRow & { associated_pr_url: string | null }>();
    for (const row of result.results ?? []) {
      if (!tasks.has(row.id)) {
        tasks.set(row.id, {
          id: row.id,
          status: row.status,
          error_message: row.error_message,
          output_pr_url: row.output_pr_url,
          agent_profile_hint: row.agent_profile_hint,
        });
      }
      if (!row.associated_pr_url) continue;
      const existing = pullRequests.get(row.id);
      if (existing) {
        if (!existing.includes(row.associated_pr_url)) existing.push(row.associated_pr_url);
      } else pullRequests.set(row.id, [row.associated_pr_url]);
    }
  }
  return { tasks, pullRequests };
}

export async function readAgentProfileNames(
  ctx: OperationContext,
  profileIds: readonly string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const ids of chunk([...new Set(profileIds)], MAX_IDS_PER_QUERY)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await ctx.env.DATABASE.prepare(
      `SELECT id, name FROM agent_profiles WHERE id IN (${placeholders})`
    )
      .bind(...ids)
      .all<{ id: string; name: string }>();
    for (const row of result.results ?? []) names.set(row.id, row.name);
  }
  return names;
}

/** Pull request URLs recorded against each task, from the PR-shepherd association rows. */
export async function readAssociatedPullRequests(
  ctx: OperationContext,
  projectId: string,
  taskIds: readonly string[]
): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  for (const ids of chunk([...new Set(taskIds)], MAX_IDS_PER_QUERY)) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await ctx.env.DATABASE.prepare(
      `SELECT task_id, pr_url FROM task_pull_request_associations
        WHERE project_id = ? AND task_id IN (${placeholders})`
    )
      .bind(projectId, ...ids)
      .all<{ task_id: string; pr_url: string }>();
    for (const row of result.results ?? []) {
      const existing = byTask.get(row.task_id);
      if (existing) existing.push(row.pr_url);
      else byTask.set(row.task_id, [row.pr_url]);
    }
  }
  return byTask;
}

/** The repository a project's pull requests must belong to, for canonicalization. */
export async function readProjectRepository(
  ctx: OperationContext,
  projectId: string
): Promise<string> {
  const row = await ctx.env.DATABASE.prepare('SELECT repository FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ repository: string }>();
  return row?.repository ?? '';
}
