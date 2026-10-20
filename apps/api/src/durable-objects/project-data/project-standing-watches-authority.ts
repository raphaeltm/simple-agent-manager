/**
 * Who may point a standing watch at a chat (idea 01M59MYE4GY91BWTE8TZF1ZB5D). A watch sends its
 * messages as its creator, so only its creator may change what it does. It is also a lasting
 * policy, so it may send messages only into a chat its creator owns: a grant lasts minutes and
 * cannot back it.
 */
import type { ProjectStandingWatch } from '@simple-agent-manager/shared';

import { OWNER_ONLY_SCHEDULE, requireScheduleAction } from './project-event-schedules-authority';
import { scheduleLimits } from './project-event-schedules-config';
import { normalizeUpdateProjectStandingWatch } from './project-event-schedules-validation';
import { ProjectEventValidationError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { stableStringify } from './project-events-values';
import { getWatch } from './project-standing-watches-storage';
import { resolveSessionAccess } from './session-access-store';
import type { Env } from './types';

/** Why the watch runner paused a watch whose target chat its creator does not own. */
export const STANDING_WATCH_TARGET_NOT_OWNED =
  'Standing watch creator does not own the target chat';

/**
 * An update that changes what a watch does must come from its creator, and its new action must
 * pass the same check as a new watch. Other changes (filter, limits, reason) stay open to any
 * maintainer, as before.
 */
export async function requireStandingWatchUpdate(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  userId: string,
  watchId: string,
  request: unknown
): Promise<void> {
  const watch = getWatch(sql, projectId, watchId);
  // A missing watch is reported by the update itself.
  if (!watch) return;
  const next = normalizeUpdateProjectStandingWatch(
    request,
    scheduleLimits(env),
    resolveProjectEventLimits(env)
  ).action;
  if (!next || stableStringify(next) === stableStringify(watch.action)) return;
  if (watch.creatorUserId !== userId) {
    throw new ProjectEventValidationError(
      'Only the person who created a standing watch can change what it does'
    );
  }
  await requireScheduleAction(sql, env, projectId, userId, next, OWNER_ONLY_SCHEDULE);
}

/**
 * True when a watch would message a chat its creator does not own. A chat with no recorded
 * owner, or one that is gone, is left to the check the message passes when it comes due, which
 * also reads the target task's owner.
 */
export function standingWatchTargetNotOwned(
  sql: SqlStorage,
  watch: Pick<ProjectStandingWatch, 'action' | 'creatorUserId'>
): boolean {
  if (watch.action.kind !== 'message_session') return false;
  const access = resolveSessionAccess(sql, watch.action.sessionId, watch.creatorUserId);
  return access.found && access.ownerUserId !== null && access.ownerUserId !== watch.creatorUserId;
}
