/**
 * Starting work on an idea: the one place that decides whether an idea may be worked on,
 * and the one place that records the new chat against it.
 *
 * Both start paths (`POST /tasks/submit` and `POST /sessions/start`) call
 * `requireOpenIdeaForWorkStart` before they create anything, so a foreign-project, non-idea
 * or closed idea is rejected with nothing to clean up, and `recordWorkStartIdeaLink`
 * after the chat session exists but before the agent receives its first prompt.
 */
import type { TaskMode } from '@simple-agent-manager/shared';
import { workStartRelationFor } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { recordLink } from './link-core';

/**
 * An idea is a `tasks` row with `status = 'draft'` (Linked work program decision 1).
 *
 * TODO(T3 rebase): T3 exports `ideaTaskPredicateSql(alias)` from `operations/idea-core.ts`
 * and T8 later widens it to `(status = 'draft' OR is_idea = 1)`. Neither is on this
 * branch's base yet, so this is the single definition T7 uses; delete it and import
 * theirs once T3 is on main. Keep exactly one definition either way (program decision 8).
 */
export function ideaTaskPredicateSql(alias = 'tasks'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`);
  return `${alias}.status = 'draft'`;
}

/** Statuses an idea can hold once it has left draft, and what to call them to a person. */
const CLOSED_IDEA_LABEL: Record<string, string> = {
  completed: 'done',
  cancelled: 'parked',
};

export interface WorkStartIdea {
  ideaId: string;
  title: string;
}

/**
 * Resolves an open idea in this project, or throws.
 *
 * The project scope lives in the SQL predicate, not only in a caller's check, so a
 * cross-project id cannot be read back at all (rule 11). A row that exists in the project
 * but is not an open idea is distinguished from one that does not exist: a done or parked
 * idea gets a 409 the person can act on, while anything else — an ordinary task, another
 * project's row, a typo — gets the same non-disclosing 404.
 */
export async function requireOpenIdeaForWorkStart(
  env: Env,
  projectId: string,
  ideaId: string
): Promise<WorkStartIdea> {
  const id = ideaId.trim();
  if (!id) throw errors.badRequest('sourceIdeaId is required');
  const row = await env.DATABASE.prepare(
    `SELECT id, title, status, ${ideaTaskPredicateSql('tasks')} AS is_idea
       FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(id, projectId)
    .first<{ id: string; title: string; status: string; is_idea: number }>();
  if (!row) throw errors.notFound('Idea');
  if (!row.is_idea) {
    const closed = CLOSED_IDEA_LABEL[row.status];
    if (closed)
      throw errors.conflict(`That idea is ${closed}. Reopen it before starting work on it.`);
    throw errors.notFound('Idea');
  }
  return { ideaId: row.id, title: row.title };
}

export interface WorkStartLinkInput {
  ideaId: string;
  sessionId: string;
  /** The task mode SAM resolved for this start, not the one the client asked for. */
  taskMode: TaskMode;
}

/**
 * Records the new chat against the idea. `works_on` for task mode, `discusses` for
 * conversation mode (`workStartRelationFor`).
 *
 * This runs before the agent's first prompt and is NOT best-effort: if it throws, the
 * caller fails the start. A chat that works on an idea without being linked to it is the
 * exact failure the old browser-side link had, and it is invisible afterwards.
 *
 * Idempotent: `recordLink` upserts, so a retried submit touches the existing row instead
 * of adding a second one.
 */
export async function recordWorkStartIdeaLink(
  env: Env,
  projectId: string,
  input: WorkStartLinkInput
): Promise<void> {
  const relation = workStartRelationFor(input.taskMode);
  try {
    await recordLink(env, projectId, {
      sourceKind: 'session',
      sourceId: input.sessionId,
      targetKind: 'idea',
      targetId: input.ideaId,
      relation,
      origin: 'explicit',
      context: null,
    });
  } catch (error) {
    log.error('start_work.idea_link_failed', {
      projectId,
      ideaId: input.ideaId,
      sessionId: input.sessionId,
      relation,
      error: String(error),
    });
    throw errors.internal(
      'Could not link this chat to the idea, so the work was not started. Try again.'
    );
  }
}
