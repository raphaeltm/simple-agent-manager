/**
 * The paged list of a project's workflow runs for REST `GET /api/projects/:projectId/workflows`
 * (`routes/workflows.ts`), with a short summary of every step. The caller authorizes first.
 * Rows are parsed one by one (rule 50), as in `workflow-run-read.ts`.
 */
import {
  DEFAULT_WORKFLOW_RUN_LIST_LIMIT,
  isWorkflowStepStatus,
  MAX_WORKFLOW_RUN_LIST_LIMIT,
  type WorkflowRunListResponse,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowStepStatus,
  type WorkflowStepSummary,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { errors } from '../middleware/error';
import { fieldSkipped, isoOrNull, parseRows, toWorkflowRunStatus } from './workflow-run-read';

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

  // One bind is the reason length, so each statement carries at most LIMIT - 1 run IDs.
  const stepPages = await env.DATABASE.batch(
    chunk(
      rows.map((row) => row.id),
      D1_MAX_BOUND_PARAMETERS - 1
    ).map((ids) =>
      env.DATABASE.prepare(
        `SELECT mission_id, step_key, title, state, substr(reason, 1, ?) AS reason
         FROM mission_steps WHERE mission_id IN (${ids.map(() => '?').join(',')})
         ORDER BY mission_id, ordinal`
      ).bind(WORKFLOW_LIST_REASON_MAX_CHARS, ...ids)
    )
  );
  const byRun = new Map<string, WorkflowStepSummary[]>();
  for (const step of parseRows(
    LIST_STEP_ROW,
    stepPages.flatMap((result) => result.results),
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
