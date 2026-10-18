import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { AppError, errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { AGENT_ACTIVITY_ACTIVE_TASK_STATUSES } from '../../services/agent-activity';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

export type TaskPullRequestTool = 'associate_pull_request' | 'list_pull_request_associations';
const text = v.pipe(v.string(), v.trim(), v.nonEmpty());
const associateArgs = v.strictObject({
  prUrl: text,
  prHeadBranch: text,
  disposition: v.picklist(['owned', 'held']),
  reason: text,
  previousTaskId: v.optional(text),
});
const listArgs = v.strictObject({ prUrl: v.optional(text) });

function canonicalPrUrl(value: string, repository: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(value);
  if (!match || match[1]!.toLowerCase() !== repository.toLowerCase()) {
    throw errors.badRequest('prUrl must be an exact GitHub PR URL in this project repository');
  }
  return `https://github.com/${repository.toLowerCase()}/pull/${match[2]}`;
}

/** Identity and current authority are always server-derived, never supplied in args. */
export async function handleTaskPullRequestAssociation(
  tool: TaskPullRequestTool,
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
) {
  try {
    const parsed = v.safeParse(
      tool === 'associate_pull_request' ? associateArgs : listArgs,
      params
    );
    if (!parsed.success) throw errors.badRequest(parsed.issues[0].message);
    if (!token.taskId) throw errors.forbidden('An active task agent is required');
    const db = drizzle(env.DATABASE, { schema });
    const project = await requireProjectCapability(
      db,
      token.projectId,
      token.userId,
      tool === 'associate_pull_request' ? 'task:write' : 'task:read'
    );
    const [caller] = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, token.taskId),
          eq(schema.tasks.projectId, token.projectId),
          eq(schema.tasks.userId, token.userId)
        )
      )
      .limit(1);
    if (
      !caller ||
      caller.supersededByTaskId ||
      !AGENT_ACTIVITY_ACTIVE_TASK_STATUSES.some((s) => s === caller.status)
    ) {
      throw errors.forbidden('The calling task must be active in this project');
    }
    if (project.repoProvider !== 'github' || !project.repository)
      throw errors.badRequest('A GitHub repository is required');
    const url = parsed.output.prUrl
      ? canonicalPrUrl(parsed.output.prUrl, project.repository)
      : undefined;
    if (tool === 'associate_pull_request') {
      const args = v.parse(associateArgs, params);
      await recordAssociation(env, token, { ...args, prUrl: url! });
    }
    const associations = await db
      .select({
        taskId: schema.taskPullRequestAssociations.taskId,
        prUrl: schema.taskPullRequestAssociations.prUrl,
        disposition: schema.taskPullRequestAssociations.disposition,
        reason: schema.taskPullRequestAssociations.reason,
        previousTaskId: schema.taskPullRequestAssociations.previousTaskId,
        recordedByUserId: schema.taskPullRequestAssociations.recordedByUserId,
        createdAt: schema.taskPullRequestAssociations.createdAt,
        ownerStatus: schema.tasks.status,
      })
      .from(schema.taskPullRequestAssociations)
      .innerJoin(
        schema.tasks,
        and(
          eq(schema.tasks.id, schema.taskPullRequestAssociations.taskId),
          eq(schema.tasks.projectId, token.projectId)
        )
      )
      .where(
        and(
          eq(schema.taskPullRequestAssociations.projectId, token.projectId),
          url ? eq(schema.taskPullRequestAssociations.prUrl, url) : undefined
        )
      );
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            associations,
            note: 'Ownership evidence only; held artifacts remain held. This does not authorize merge or cleanup.',
          }),
        },
      ],
    });
  } catch (error) {
    return jsonRpcError(
      requestId,
      error instanceof AppError ? INVALID_PARAMS : INTERNAL_ERROR,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function recordAssociation(
  env: Env,
  token: McpTokenData,
  args: {
    prUrl: string;
    prHeadBranch: string;
    disposition: 'owned' | 'held';
    reason: string;
    previousTaskId?: string;
  }
) {
  // One statement serializes competing claims and rechecks task state at write time.
  // History is retained; a held predecessor cannot be silently promoted to a release.
  const active = AGENT_ACTIVITY_ACTIVE_TASK_STATUSES.map(() => '?').join(',');
  const result = await env.DATABASE.prepare(
    `
    INSERT INTO task_pull_request_associations
      (task_id, project_id, pr_url, disposition, reason, previous_task_id, recorded_by_user_id, created_at)
    SELECT t.id, t.project_id, ?, ?, ?, ?, ?, ? FROM tasks t
    WHERE t.id = ? AND t.project_id = ? AND t.user_id = ?
      AND t.status IN (${active}) AND t.superseded_by_task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tasks other LEFT JOIN workspaces w ON w.id = other.workspace_id AND w.project_id = other.project_id
        WHERE other.project_id = t.project_id AND other.id != t.id
          AND other.status IN (${active}) AND other.superseded_by_task_id IS NULL
          AND (other.output_pr_url = ? OR instr(lower(other.description), lower(?)) > 0
            OR other.output_branch = ? OR w.branch = ? OR EXISTS (
            SELECT 1 FROM task_pull_request_associations a
            WHERE a.task_id = other.id AND a.project_id = t.project_id AND a.pr_url = ?
          ))
      )
      AND (? IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM tasks predecessor WHERE predecessor.project_id = t.project_id AND predecessor.id != t.id
          AND (predecessor.output_pr_url = ? OR EXISTS (
            SELECT 1 FROM task_pull_request_associations a
            WHERE a.task_id = predecessor.id AND a.project_id = t.project_id AND a.pr_url = ?
          ))
      ))
      AND NOT EXISTS (
        SELECT 1 FROM task_pull_request_associations a
        WHERE a.project_id = t.project_id AND a.pr_url = ? AND a.task_id != t.id AND a.disposition = 'held'
      )
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM tasks predecessor WHERE predecessor.id = ?
          AND predecessor.project_id = t.project_id AND predecessor.user_id = t.user_id
          AND predecessor.status IN ('completed','failed','cancelled')
          AND (predecessor.output_pr_url = ? OR EXISTS (
            SELECT 1 FROM task_pull_request_associations a
            WHERE a.task_id = predecessor.id AND a.project_id = t.project_id AND a.pr_url = ?
          ))
      ))
    ON CONFLICT(task_id, pr_url) DO NOTHING
  `
  )
    .bind(
      args.prUrl,
      args.disposition,
      args.reason,
      args.previousTaskId ?? null,
      token.userId,
      new Date().toISOString(),
      token.taskId,
      token.projectId,
      token.userId,
      ...AGENT_ACTIVITY_ACTIVE_TASK_STATUSES,
      ...AGENT_ACTIVITY_ACTIVE_TASK_STATUSES,
      args.prUrl,
      args.prUrl,
      args.prHeadBranch,
      args.prHeadBranch,
      args.prUrl,
      args.previousTaskId ?? null,
      args.prUrl,
      args.prUrl,
      args.prUrl,
      args.previousTaskId ?? null,
      args.previousTaskId ?? null,
      args.prUrl,
      args.prUrl
    )
    .run();
  if (result.meta.changes) return;
  // Exact retry is idempotent; changing a hold/reason/predecessor is not a retry.
  const existing = await env.DATABASE.prepare(
    `SELECT disposition, reason, previous_task_id AS previousTaskId
    FROM task_pull_request_associations WHERE task_id = ? AND project_id = ? AND pr_url = ?`
  )
    .bind(token.taskId, token.projectId, args.prUrl)
    .first<{ disposition: string; reason: string; previousTaskId: string | null }>();
  if (
    existing?.disposition === args.disposition &&
    existing.reason === args.reason &&
    existing.previousTaskId === (args.previousTaskId ?? null)
  )
    return;
  throw errors.badRequest(
    'Association conflicts with existing ownership, a hold, task state, or continuation evidence'
  );
}
