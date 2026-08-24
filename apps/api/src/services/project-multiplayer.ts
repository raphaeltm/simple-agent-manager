import { and, count, eq, gt, isNull } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { AppDb } from '../middleware/project-auth';
import { parseCacheTtlMs } from './cache-config';

export const DEFAULT_PROJECT_MULTIPLAYER_CACHE_TTL_MS = 10_000;

export interface ProjectMultiplayerState {
  activeMemberCount: number;
  hasActiveInviteLink: boolean;
  hasPendingAccessRequest: boolean;
  multiplayerActive: boolean;
}

interface MultiplayerCacheEntry {
  expiresAt: number;
  state: ProjectMultiplayerState;
}

const multiplayerCache = new Map<string, MultiplayerCacheEntry>();

export function clearProjectMultiplayerStateCache(projectId?: string): void {
  if (projectId) {
    multiplayerCache.delete(projectId);
    return;
  }
  multiplayerCache.clear();
}

export function getProjectMultiplayerCacheTtlMs(env?: {
  PROJECT_MULTIPLAYER_CACHE_TTL_MS?: string;
}): number {
  return parseCacheTtlMs(
    env?.PROJECT_MULTIPLAYER_CACHE_TTL_MS,
    DEFAULT_PROJECT_MULTIPLAYER_CACHE_TTL_MS
  );
}

export async function getProjectMultiplayerState(
  db: AppDb,
  projectId: string,
  now = new Date(),
  env?: { PROJECT_MULTIPLAYER_CACHE_TTL_MS?: string }
): Promise<ProjectMultiplayerState> {
  const ttlMs = getProjectMultiplayerCacheTtlMs(env);
  const nowMs = now.getTime();
  const cached = multiplayerCache.get(projectId);
  if (ttlMs > 0 && cached && cached.expiresAt > nowMs) {
    return cached.state;
  }

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

  const state = {
    activeMemberCount,
    hasActiveInviteLink,
    hasPendingAccessRequest,
    multiplayerActive:
      activeMemberCount > 1 || hasActiveInviteLink || hasPendingAccessRequest,
  };
  if (ttlMs > 0) {
    multiplayerCache.set(projectId, { expiresAt: nowMs + ttlMs, state });
  }
  return state;
}
