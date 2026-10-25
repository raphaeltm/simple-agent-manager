/**
 * Which tasks make up a team: a task and its subtasks, the task behind a chat, or every task
 * dispatched with one coordination channel.
 *
 * Lineage is read with one bounded recursive query over `tasks.parent_task_id` (indexed by D1
 * migration 0208), depth-limited so a cycle or a very deep tree cannot run away. The page is
 * ordered for the reader: shallower levels first so every kept task's parent is kept too, then
 * live work before finished work, then most recently updated. Rows past the cap are disclosed,
 * not silently dropped.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { OperationError } from './errors';

export type TeamScope =
  | { kind: 'task'; taskId: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'channel'; channel: string };

const text = v.string();
const nullableText = v.nullable(v.string());
const TeamTaskRowSchema = v.object({
  id: text,
  title: text,
  status: text,
  executionStep: nullableText,
  parentTaskId: nullableText,
  depth: v.number(),
  triggeredBy: text,
  dispatchDepth: v.number(),
  userId: text,
  chatSessionId: nullableText,
  workspaceId: nullableText,
  supersededByTaskId: nullableText,
  outputBranch: nullableText,
  outputPrUrl: nullableText,
  outputCommitSha: nullableText,
  outputSummary: nullableText,
  completionEvidence: nullableText,
  errorMessage: nullableText,
  admissionState: nullableText,
  admissionReason: nullableText,
  providerLimitWaitJson: nullableText,
  credentialBlockedReason: nullableText,
  coordinationChannel: nullableText,
  taskMode: text,
  createdAt: text,
  startedAt: nullableText,
  updatedAt: text,
  completedAt: nullableText,
});

export type TeamTaskRow = v.InferOutput<typeof TeamTaskRowSchema>;

/** One malformed task row is left out and logged; it must not hide the rest of the team. */
function parseTeamRows(rows: unknown[], projectId: string): TeamTaskRow[] {
  const parsed: TeamTaskRow[] = [];
  for (const row of rows) {
    const result = v.safeParse(TeamTaskRowSchema, row);
    if (result.success) {
      parsed.push(result.output);
      continue;
    }
    log.warn('connector.team_task_row_skipped', {
      projectId,
      taskId:
        row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? row.id : null,
      error: result.issues[0]?.message ?? 'invalid row',
    });
  }
  return parsed;
}

const TASK_COLUMNS = `t.id AS id, t.title AS title, t.status AS status,
  t.execution_step AS executionStep, t.parent_task_id AS parentTaskId,
  t.triggered_by AS triggeredBy, t.dispatch_depth AS dispatchDepth, t.user_id AS userId,
  t.chat_session_id AS chatSessionId, t.workspace_id AS workspaceId,
  t.superseded_by_task_id AS supersededByTaskId, t.output_branch AS outputBranch,
  t.output_pr_url AS outputPrUrl, t.output_commit_sha AS outputCommitSha,
  t.output_summary AS outputSummary, t.completion_evidence AS completionEvidence,
  t.error_message AS errorMessage, t.admission_state AS admissionState,
  t.admission_reason AS admissionReason, t.provider_limit_wait_json AS providerLimitWaitJson,
  t.credential_blocked_reason AS credentialBlockedReason,
  t.coordination_channel AS coordinationChannel, t.task_mode AS taskMode,
  t.created_at AS createdAt, t.started_at AS startedAt, t.updated_at AS updatedAt,
  t.completed_at AS completedAt`;

/** Live work first: what the reader is most likely checking on. */
const READER_ORDER = `CASE WHEN t.status IN ('queued','delegated','in_progress','sleeping')
  THEN 0 ELSE 1 END, t.updated_at DESC, t.id ASC`;

async function rootTaskId(
  env: Env,
  projectId: string,
  scope: Exclude<TeamScope, { kind: 'channel' }>
): Promise<string> {
  if (scope.kind === 'task') return scope.taskId;
  const row = await env.DATABASE.prepare(
    'SELECT id FROM tasks WHERE project_id = ? AND chat_session_id = ? LIMIT 1'
  )
    .bind(projectId, scope.sessionId)
    .first<{ id: string }>();
  if (!row) throw new OperationError('not_found', 'No task is linked to this chat in the project');
  return row.id;
}

/** The team's tasks, at most `maxTasks`, and whether more exist. */
export async function readTeamTasks(
  env: Env,
  projectId: string,
  scope: TeamScope,
  caps: { maxTasks: number; maxDepth: number }
): Promise<{ rows: TeamTaskRow[]; truncated: boolean; rootTaskId: string | null }> {
  let rows: TeamTaskRow[];
  let root: string | null = null;
  if (scope.kind === 'channel') {
    const result = await env.DATABASE.prepare(
      `SELECT ${TASK_COLUMNS}, t.dispatch_depth AS depth FROM tasks t
       WHERE t.project_id = ? AND t.coordination_channel = ?
       ORDER BY t.dispatch_depth ASC, ${READER_ORDER}
       LIMIT ?`
    )
      .bind(projectId, scope.channel, caps.maxTasks + 1)
      .all<Record<string, unknown>>();
    rows = parseTeamRows(result.results ?? [], projectId);
  } else {
    root = await rootTaskId(env, projectId, scope);
    const result = await env.DATABASE.prepare(
      `WITH RECURSIVE lineage(id, depth) AS (
         SELECT id, 0 FROM tasks WHERE id = ?1 AND project_id = ?2
         UNION ALL
         SELECT child.id, lineage.depth + 1 FROM tasks child
         JOIN lineage ON child.parent_task_id = lineage.id
         WHERE child.project_id = ?2 AND lineage.depth < ?3
       )
       SELECT ${TASK_COLUMNS}, lineage.depth AS depth FROM lineage
       JOIN tasks t ON t.id = lineage.id AND t.project_id = ?2
       ORDER BY lineage.depth ASC, ${READER_ORDER}
       LIMIT ?4`
    )
      .bind(root, projectId, caps.maxDepth, caps.maxTasks + 1)
      .all<Record<string, unknown>>();
    rows = parseTeamRows(result.results ?? [], projectId);
    if (rows.length === 0) throw new OperationError('not_found', 'Task not found in this project');
  }
  return {
    rows: rows.slice(0, caps.maxTasks),
    truncated: rows.length > caps.maxTasks,
    rootTaskId: root,
  };
}
