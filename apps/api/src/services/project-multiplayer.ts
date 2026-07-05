import { and, count, eq, gt, isNull } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { AppDb } from '../middleware/project-auth';

export interface ProjectMultiplayerState {
  activeMemberCount: number;
  hasActiveInviteLink: boolean;
  hasPendingAccessRequest: boolean;
  multiplayerActive: boolean;
}

export async function getProjectMultiplayerState(
  db: AppDb,
  projectId: string,
  now = new Date()
): Promise<ProjectMultiplayerState> {
  const nowIso = now.toISOString();
  const [activeMembers, activeInvites, pendingRequests] = await Promise.all([
    db
      .select({ count: count() })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.status, 'active')
        )
      ),
    db
      .select({ count: count() })
      .from(schema.projectInviteLinks)
      .where(
        and(
          eq(schema.projectInviteLinks.projectId, projectId),
          isNull(schema.projectInviteLinks.revokedAt),
          gt(schema.projectInviteLinks.expiresAt, nowIso)
        )
      ),
    db
      .select({ count: count() })
      .from(schema.projectAccessRequests)
      .where(
        and(
          eq(schema.projectAccessRequests.projectId, projectId),
          eq(schema.projectAccessRequests.status, 'pending')
        )
      ),
  ]);

  const activeMemberCount = Number(activeMembers[0]?.count ?? 0);
  const hasActiveInviteLink = Number(activeInvites[0]?.count ?? 0) > 0;
  const hasPendingAccessRequest = Number(pendingRequests[0]?.count ?? 0) > 0;

  return {
    activeMemberCount,
    hasActiveInviteLink,
    hasPendingAccessRequest,
    multiplayerActive:
      activeMemberCount > 1 || hasActiveInviteLink || hasPendingAccessRequest,
  };
}
