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
 * A failure is logged, not thrown: the revocation itself is already committed, the RPC retries
 * transient faults, and failing the request would not close the socket either.
 */
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import * as projectDataService from './project-data';

const log = createModuleLogger('project_socket_revocation');

export type SocketRevocationReason = 'member_removed' | 'account_suspended';

export async function closeRevokedMemberSockets(
  env: Env,
  projectId: string,
  userId: string,
  reason: SocketRevocationReason
): Promise<void> {
  try {
    const closed = await projectDataService.closeBrowserSocketsForActor(env, projectId, userId);
    log.info('project_sockets.closed_for_revoked_access', { projectId, userId, reason, closed });
  } catch (err) {
    log.error('project_sockets.close_failed', {
      projectId,
      userId,
      reason,
      action: 'left_open',
      ...serializeError(err),
    });
  }
}

/**
 * Close a suspended user's sockets on every project they were an active member of. Admin
 * suspension is rare and a user's memberships number in the tens, so the RPCs run in parallel.
 */
export async function closeSuspendedUserSockets(env: Env, userId: string): Promise<void> {
  const rows = await env.DATABASE.prepare(
    `SELECT project_id FROM project_members WHERE user_id = ? AND status = 'active'`
  )
    .bind(userId)
    .all<{ project_id: unknown }>();
  const projectIds = (rows.results ?? []).flatMap((row) =>
    typeof row.project_id === 'string' ? [row.project_id] : []
  );
  await Promise.all(
    projectIds.map((projectId) =>
      closeRevokedMemberSockets(env, projectId, userId, 'account_suspended')
    )
  );
}
