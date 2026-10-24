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
import { ideaTaskPredicateSql } from './idea-identity';
import { recordLink } from './link-core';

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
 * "Is it an idea" is asked first, and its answer is final. A row that is not an idea gets one
 * non-disclosing answer whatever its status, exactly like a foreign-project id or a typo
 * (rule 11). The caller is authorized for this project, but that does not entitle them to
 * learn that an id they guessed names a completed task. Testing the status first answers
 * `409 "That idea is done."` for any ordinary completed or cancelled row, which is why the
 * order here is load-bearing rather than stylistic.
 *
 * The order used to be the other way round, and was safe at the time, because the only
 * discriminator WAS the status: with an idea defined as `status = 'draft'`, a closed idea and
 * a closed ordinary task were the same row shape, so neither answer could be withheld from
 * the other. `tasks.is_idea` (program decision 16, migration 0207) separates them, which
 * removed the ambiguity and the excuse with it.
 *
 * Openness is still read off `status` directly rather than inferred from
 * `ideaTaskPredicateSql`. The two must keep disagreeing: the predicate is `is_idea = 1`, which
 * stays true after an idea is marked done, so `if (!isIdea) …` alone would make a DONE idea
 * startable.
 */
export function classifyWorkStartIdea(status: string, isIdea: boolean): WorkStartAdmission {
  if (!isIdea) return { outcome: 'not-an-open-idea' };
  if (status === OPEN_IDEA_STATUS) return { outcome: 'open' };
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
 * ordinary open task all get the same non-disclosing 404 — as does an ordinary CLOSED task,
 * whose status is not the caller's to learn. Only a real idea that is done or parked gets the
 * 409 the person can act on; see `classifyWorkStartIdea` for why that order matters.
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
