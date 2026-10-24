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

/** The status an open idea holds. Start work is only offered for an open idea. */
const OPEN_IDEA_STATUS = 'draft';

/** Statuses an idea can hold once it has left draft, and what to call them to a person. */
const CLOSED_IDEA_LABEL: Record<string, string> = {
  completed: 'done',
  cancelled: 'parked',
};

/** What the admission check decided, so the matrix can be tested without a database. */
export type WorkStartAdmission =
  { outcome: 'open' } | { outcome: 'closed'; label: string } | { outcome: 'not-an-open-idea' };

/**
 * Two independent questions, deliberately kept independent: is this row an idea, and is that
 * idea open?
 *
 * Today they happen to be the same SQL test, because `ideaTaskPredicateSql` is
 * `status = 'draft'`. T8's migration widens it to `(status = 'draft' OR is_idea = 1)` so an
 * idea stays an idea after it is marked done. If openness were inferred from the predicate —
 * `if (!isIdea) …` — that widening would silently make a DONE idea startable, with nothing in
 * T8's diff to show it. So openness is tested on `status` directly and the predicate is only
 * ever asked whether the row is an idea at all.
 *
 * One case is genuinely ambiguous until T8 lands: a completed or cancelled row that is NOT an
 * idea is indistinguishable from a completed or cancelled idea, because the only discriminator
 * today IS the status. Those rows get the 409 rather than the 404 they will get afterwards.
 * It is the safe direction — the caller is already authorized for this project, and the start
 * is refused either way.
 */
export function classifyWorkStartIdea(status: string, isIdea: boolean): WorkStartAdmission {
  if (isIdea && status === OPEN_IDEA_STATUS) return { outcome: 'open' };
  const label = CLOSED_IDEA_LABEL[status];
  if (label) return { outcome: 'closed', label };
  return { outcome: 'not-an-open-idea' };
}

export interface WorkStartIdea {
  ideaId: string;
  title: string;
}

/**
 * Resolves an open idea in this project, or throws.
 *
 * The project scope lives in the SQL predicate, not only in a caller's check, so a
 * cross-project id cannot be read back at all (rule 11). Another project's id, a typo and an
 * ordinary open task all get the same non-disclosing 404. A done or parked idea gets a 409
 * the person can act on instead — see `classifyWorkStartIdea` for the one row shape that is
 * ambiguous until T8's `tasks.is_idea` column exists.
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
  const admission = classifyWorkStartIdea(row.status, row.is_idea === 1);
  if (admission.outcome === 'closed')
    throw errors.conflict(`That idea is ${admission.label}. Reopen it before starting work on it.`);
  if (admission.outcome !== 'open') throw errors.notFound('Idea');
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
