/**
 * The only place that decides which statuses a person may move an idea to.
 *
 * Three call sites used to disagree. `operations/idea-core.ts` allowed `ready → completed`;
 * `services/task-status.ts` forbade it and offered no way back from `completed`; and the
 * generic task status route (`routes/tasks/crud.ts`) validated idea rows with the *task*
 * table, so the same request succeeded or failed depending on which surface made it. An idea
 * is not a task in flight — it never reaches `queued`, and a person must be able to mark one
 * done, park it, and change their mind — so it gets its own table, and every surface asks
 * this module.
 *
 * `ready` is a status an idea may still BE in, and never one it may move TO. The program's
 * decision 1 is that ideas are never run in place: `draft → ready → POST /tasks/:id/run` is
 * the legacy path that turns an idea row into a task row, and Start work creates a new linked
 * task instead. Rows that reached `ready` before that decision keep every way out of it, so
 * the tightening refuses a new entry without stranding an existing idea (rule 71).
 *
 * It carries no derived meaning either way: `idea-status.ts` treats `draft` and `ready`
 * identically, and `IDEA_OPEN_STATUSES` lists both so a legacy `ready` idea still appears.
 */
import { ulid } from '../lib/ulid';
import { OperationError } from './errors';
import { ideaTaskPredicateSql, isIdeaRow } from './idea-core';
import type { OperationContext } from './types';

/** Statuses an idea row can hold, and where each can go. */
export const IDEA_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // No `ready`: an idea is not run in place (program decision 1).
  draft: Object.freeze(['completed', 'cancelled']),
  // Every exit a legacy `ready` idea had, kept.
  ready: Object.freeze(['draft', 'completed', 'cancelled']),
  // Done and parked are reversible: a merged pull request often leaves something behind,
  // and the design asks people to decide, which means letting them decide again.
  completed: Object.freeze(['draft']),
  cancelled: Object.freeze(['draft']),
});

/** An idea nobody has finished or parked. */
export const IDEA_OPEN_STATUSES: readonly string[] = Object.freeze(['draft', 'ready']);

export function isIdeaOpenStatus(status: string): boolean {
  return IDEA_OPEN_STATUSES.includes(status);
}

export function isIdeaStatus(status: string): boolean {
  return status in IDEA_STATUS_TRANSITIONS;
}

export function getAllowedIdeaTransitions(from: string): readonly string[] {
  return IDEA_STATUS_TRANSITIONS[from] ?? [];
}

export function canTransitionIdeaStatus(from: string, to: string): boolean {
  if (from === to) return true;
  return getAllowedIdeaTransitions(from).includes(to);
}

/** The reason a transition is refused, or null when it is allowed. Shared by every surface. */
export function validateIdeaStatusTransition(
  currentStatus: string,
  newStatus: string
): string | null {
  if (!isIdeaStatus(currentStatus)) return `Not an idea status: '${currentStatus}'`;
  if (!isIdeaStatus(newStatus)) return `Not an idea status: '${newStatus}'`;
  if (canTransitionIdeaStatus(currentStatus, newStatus)) return null;
  const allowed = getAllowedIdeaTransitions(currentStatus);
  return `Invalid status transition: ${currentStatus} → ${newStatus}. Allowed: ${
    allowed.join(', ') || 'none'
  }`;
}

export interface IdeaStatusTransitionInput {
  projectId: string;
  ideaId: string;
  /** Any idea status. Validated against {@link IDEA_STATUS_TRANSITIONS}, never trusted. */
  status: string;
}

export interface IdeaStatusTransitionResult {
  ideaId: string;
  fromStatus: string;
  toStatus: string;
  /** False when the idea was already in the requested status. */
  changed: boolean;
}

/**
 * Moves one idea to a status a person chose: "Mark done" (`completed`), "Park" (`cancelled`)
 * or "Keep open" / reopen (`draft`).
 *
 * The idea is read inside the project scope first, and `project_id` is in the write predicate
 * too, so a row from another project is neither disclosed nor touched (rule 11).
 */
export async function applyIdeaStatusTransition(
  ctx: OperationContext,
  input: IdeaStatusTransitionInput
): Promise<IdeaStatusTransitionResult> {
  const ideaId = typeof input.ideaId === 'string' ? input.ideaId.trim() : '';
  if (!ideaId) throw new OperationError('invalid_input', 'ideaId is required');

  const existing = await ctx.env.DATABASE.prepare(
    'SELECT id, status, is_idea FROM tasks WHERE id = ? AND project_id = ?'
  )
    .bind(ideaId, input.projectId)
    .first<{ id: string; status: string; is_idea: number }>();
  if (!existing || !isIdeaRow(existing)) {
    throw new OperationError('not_found', `Idea not found in this project: ${ideaId}`);
  }

  const error = validateIdeaStatusTransition(existing.status, input.status);
  if (error) throw new OperationError('conflict', error);

  if (existing.status === input.status) {
    return { ideaId, fromStatus: existing.status, toStatus: input.status, changed: false };
  }

  const now = new Date().toISOString();
  // `completed_at` is what "shipped <when>" reads on the idea page, and it has to be cleared
  // again when someone reopens the idea, or a reopened idea keeps claiming it finished.
  const completedAt = input.status === 'completed' ? now : null;
  await ctx.env.DATABASE.batch([
    ctx.env.DATABASE.prepare(
      `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND ${ideaTaskPredicateSql()}`
    ).bind(input.status, completedAt, now, ideaId, input.projectId),
    ctx.env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
    ).bind(ulid(), ideaId, existing.status, input.status, ctx.actor.userId, null, now),
  ]);

  return { ideaId, fromStatus: existing.status, toStatus: input.status, changed: true };
}

/**
 * Records that a person answered this idea's merged-pull-request question with "Keep open".
 *
 * It changes no status: the idea stays exactly where it is. What it changes is whether the
 * question comes back, which is why it has its own column rather than relying on the row's
 * `updated_at` — an agent posting a note must not be able to answer a question that was put
 * to a person.
 */
export async function acknowledgeIdeaMerge(
  ctx: OperationContext,
  input: { projectId: string; ideaId: string }
): Promise<{ ideaId: string; acknowledgedAt: string }> {
  const ideaId = typeof input.ideaId === 'string' ? input.ideaId.trim() : '';
  if (!ideaId) throw new OperationError('invalid_input', 'ideaId is required');

  const acknowledgedAt = new Date().toISOString();
  const result = await ctx.env.DATABASE.prepare(
    `UPDATE tasks SET idea_merge_ack_at = ?
      WHERE id = ? AND project_id = ? AND ${ideaTaskPredicateSql()}`
  )
    .bind(acknowledgedAt, ideaId, input.projectId)
    .run();
  if (!result.meta.changes) {
    throw new OperationError('not_found', `Idea not found in this project: ${ideaId}`);
  }
  return { ideaId, acknowledgedAt };
}
