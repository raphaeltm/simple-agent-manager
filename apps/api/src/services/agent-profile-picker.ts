/**
 * New-chat profile picker state for one person in one project.
 *
 * - usage: which profiles this person started new chats with recently, so the picker
 *   can pre-select the last one and show recent profiles first. Derived from
 *   `tasks.agent_profile_hint`; nothing new is tracked.
 * - hidden: profiles this person hid from their own picker. Hiding never affects the
 *   profile itself, other members, automations, dispatch or @mentions.
 *
 * Idea 01M5EW9H86VD88S7E3WWA1D9X1.
 */
import type { ProfilePickerState, UpdateProfilePickerRequest } from '@simple-agent-manager/shared';
import { and, count, eq, gte, inArray, isNotNull, isNull, max, ne, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { resolveAdminSetting } from './admin-settings';
import { DEFAULT_PROFILE_USAGE_WINDOW_DAYS } from './admin-settings-registry';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const DAY_MS = 86_400_000;
/** Profile ids per `IN (...)` list: the D1 bind limit less the user and project. */
const IDS_PER_STATEMENT = D1_MAX_BOUND_PARAMETERS - 2;
/** Rows per insert: user, project and profile are bound; created_at is a SQL default. */
const ROWS_PER_INSERT = Math.floor(D1_MAX_BOUND_PARAMETERS / 3);

/** Admin setting `chat.profileUsageWindowDays`; degrades to the default on a store outage. */
export async function getProfileUsageWindowDays(env: Env): Promise<number> {
  const value = await resolveAdminSetting(env, 'chat.profileUsageWindowDays');
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PROFILE_USAGE_WINDOW_DAYS;
}

/** D1 `datetime('now')` defaults lack the ISO `T`/`Z`; normalise so clients can order them. */
function toIsoTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

/** A person's own hand-started new chats: not dispatched, triggered, recovered or an idea draft. */
function ownNewChatsSince(projectId: string, userId: string, since: string) {
  return and(
    eq(schema.tasks.projectId, projectId),
    eq(schema.tasks.userId, userId),
    eq(schema.tasks.triggeredBy, 'user'),
    eq(schema.tasks.dispatchDepth, 0),
    isNull(schema.tasks.recoverySourceTaskId),
    isNotNull(schema.tasks.agentProfileHint),
    ne(schema.tasks.status, 'draft'),
    gte(schema.tasks.createdAt, since)
  );
}

function hiddenRowsFor(db: Db, projectId: string, userId: string) {
  return db
    .select({ profileId: schema.agentProfilePickerHidden.profileId })
    .from(schema.agentProfilePickerHidden)
    .where(
      and(
        eq(schema.agentProfilePickerHidden.userId, userId),
        eq(schema.agentProfilePickerHidden.projectId, projectId)
      )
    );
}

export async function getProfilePickerState(
  db: Db,
  projectId: string,
  userId: string,
  usageWindowDays: number,
  now: Date = new Date()
): Promise<ProfilePickerState> {
  const since = new Date(now.getTime() - usageWindowDays * DAY_MS).toISOString();
  const [usageRows, hiddenRows] = await db.batch([
    db
      .select({
        profileId: schema.tasks.agentProfileHint,
        lastUsedAt: max(schema.tasks.createdAt),
        chatCount: count(),
      })
      .from(schema.tasks)
      .where(ownNewChatsSince(projectId, userId, since))
      .groupBy(schema.tasks.agentProfileHint),
    hiddenRowsFor(db, projectId, userId),
  ]);

  const usage = usageRows.flatMap((row) =>
    row.profileId && row.lastUsedAt
      ? [
          {
            profileId: row.profileId,
            lastUsedAt: toIsoTimestamp(row.lastUsedAt),
            chatCount: row.chatCount,
          },
        ]
      : []
  );
  usage.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  return {
    usage,
    hiddenProfileIds: hiddenRows.map((row) => row.profileId),
    usageWindowDays,
  };
}

/**
 * Hide and/or unhide profiles in the caller's own picker. Only profiles the caller can
 * use in this project may be hidden; every write is scoped to (user, project).
 */
export async function updateHiddenProfiles(
  db: Db,
  projectId: string,
  userId: string,
  body: UpdateProfilePickerRequest
): Promise<string[]> {
  const hide = [...new Set(body.hide ?? [])];
  const unhide = [...new Set(body.unhide ?? [])];
  if (hide.some((id) => unhide.includes(id))) {
    throw errors.badRequest('A profile cannot be hidden and shown in the same request');
  }

  if (hide.length > 0) {
    const accessibleIds = new Set<string>();
    for (const ids of chunk(hide, IDS_PER_STATEMENT)) {
      const accessible = await db
        .select({ id: schema.agentProfiles.id })
        .from(schema.agentProfiles)
        .where(
          and(
            inArray(schema.agentProfiles.id, ids),
            or(
              eq(schema.agentProfiles.projectId, projectId),
              and(isNull(schema.agentProfiles.projectId), eq(schema.agentProfiles.userId, userId))
            )
          )
        );
      for (const row of accessible) accessibleIds.add(row.id);
    }
    const rejected = hide.filter((id) => !accessibleIds.has(id));
    if (rejected.length > 0) {
      log.warn('agent_profile_picker.hide_rejected', {
        projectId,
        userId,
        rejectedProfileIds: rejected,
        action: 'rejected',
      });
      throw errors.badRequest('One or more profiles are not available in this project');
    }
    for (const ids of chunk(hide, ROWS_PER_INSERT)) {
      await db
        .insert(schema.agentProfilePickerHidden)
        .values(ids.map((profileId) => ({ userId, projectId, profileId })))
        .onConflictDoNothing();
    }
  }
  for (const ids of chunk(unhide, IDS_PER_STATEMENT)) {
    await db
      .delete(schema.agentProfilePickerHidden)
      .where(
        and(
          eq(schema.agentProfilePickerHidden.userId, userId),
          eq(schema.agentProfilePickerHidden.projectId, projectId),
          inArray(schema.agentProfilePickerHidden.profileId, ids)
        )
      );
  }
  const hiddenRows = await hiddenRowsFor(db, projectId, userId);
  return hiddenRows.map((row) => row.profileId);
}
