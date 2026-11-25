/**
 * Close a user's project WebSockets when their access to the project ends.
 *
 * The upgrade route (`GET /api/projects/:projectId/sessions/ws`, `routes/chat.ts`) checks
 * membership once, when the socket opens, and tags the socket with the user. A socket opened
 * before the user was removed or suspended would otherwise keep receiving project events until
 * the tab closed. Every path that revokes project access calls one of these:
 * - member offboarding (`routes/projects/member-offboarding.ts`, `status = 'removed'`);
 * - account suspension (`routes/admin.ts`).
 *
 * `closeRevokedMemberSockets` logs a failure and returns `false` rather than throwing: the
 * revocation itself is already committed and the RPC retries transient faults. Suspension turns a
 * failure into a retryable 503, because suspending again is idempotent and re-runs the close.
 * Offboarding cannot be re-applied once the member is removed, so it only logs. A reconciling
 * sweep that would also close the remainder is tracked in
 * `tasks/backlog/2026-11-18-project-socket-access-reconcile.md`.
 */
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import { errors } from '../middleware/error';
import * as projectDataService from './project-data';

const log = createModuleLogger('project_socket_revocation');

export type SocketRevocationReason = 'member_removed' | 'account_suspended';

export async function closeRevokedMemberSockets(
  env: Env,
  projectId: string,
  userId: string,
  reason: SocketRevocationReason
): Promise<boolean> {
  try {
    const closed = await projectDataService.closeBrowserSocketsForActor(env, projectId, userId);
    log.info('project_sockets.closed_for_revoked_access', { projectId, userId, reason, closed });
    return true;
  } catch (err) {
    log.error('project_sockets.close_failed', {
      projectId,
      userId,
      reason,
      action: 'left_open',
      ...serializeError(err),
    });
    return false;
  }
}

/** Memberships read per D1 query, and close RPCs in flight at once, while suspending. */
const SUSPENSION_MEMBERSHIP_PAGE_SIZE = 100;
const SUSPENSION_CLOSE_CONCURRENCY = 10;

const PARTIAL_SUSPENSION_MESSAGE =
  'The account is suspended, but some open project connections could not be closed. Suspend it again to retry.';

/**
 * Close a suspended user's sockets on every project they are an active member of, and on every
 * project they were removed from since `removedSince` (the start of this suspension). A retry must
 * still reach a project whose membership was removed after an earlier close failed: offboarding
 * only logs its own close failure, so nothing else would close that socket. Bounding the former
 * memberships by the suspension start keeps the fan-out at the active rows plus the few removals
 * made while the account was suspended, rather than every membership the user ever had.
 *
 * Rows are read a page at a time (seeking by `project_id`) and closed a bounded batch at a time;
 * every page is processed even when a close fails, then any failure answers a retryable 503.
 * Suspending again is idempotent and re-runs the closes.
 */
export async function closeSuspendedUserSockets(
  env: Env,
  userId: string,
  removedSince: Date
): Promise<void> {
  const since = removedSince.toISOString();
  let failed = false;
  let after = '';
  for (;;) {
    let projectIds: string[];
    try {
      const rows = await env.DATABASE.prepare(
        `SELECT project_id FROM project_members
          WHERE user_id = ?
            AND (status = 'active' OR (status = 'removed' AND removed_at >= ?))
            AND project_id > ?
          ORDER BY project_id LIMIT ?`
      )
        .bind(userId, since, after, SUSPENSION_MEMBERSHIP_PAGE_SIZE)
        .all<{ project_id: unknown }>();
      projectIds = (rows.results ?? []).flatMap((row) =>
        typeof row.project_id === 'string' ? [row.project_id] : []
      );
    } catch (err) {
      log.error('project_sockets.suspension_membership_read_failed', {
        userId,
        after,
        action: 'left_open',
        ...serializeError(err),
      });
      throw errors.serviceUnavailable(PARTIAL_SUSPENSION_MESSAGE);
    }
    for (let start = 0; start < projectIds.length; start += SUSPENSION_CLOSE_CONCURRENCY) {
      const batch = projectIds.slice(start, start + SUSPENSION_CLOSE_CONCURRENCY);
      const results = await Promise.all(
        batch.map((projectId) =>
          closeRevokedMemberSockets(env, projectId, userId, 'account_suspended')
        )
      );
      if (results.includes(false)) failed = true;
    }
    const last = projectIds.at(-1);
    if (projectIds.length < SUSPENSION_MEMBERSHIP_PAGE_SIZE || last === undefined) break;
    after = last;
  }
  if (failed) throw errors.serviceUnavailable(PARTIAL_SUSPENSION_MESSAGE);
}
