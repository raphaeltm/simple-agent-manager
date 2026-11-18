/**
 * A departing member's personal profile pins on a project's profiles. They are
 * private account choices that only ever applied to that member's own runs, so
 * they need no decision: the preview counts them and removal deletes them. Pins
 * on the member's own global profiles are not project resources and stay.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { AppDb } from '../middleware/project-auth';

function projectProfileIds(db: AppDb, projectId: string) {
  return db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.projectId, projectId));
}

export async function countProjectProfilePins(
  db: AppDb,
  projectId: string,
  memberUserId: string
): Promise<number> {
  const pins = schema.ccProfileAttachments;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(pins)
    .where(
      and(
        eq(pins.userId, memberUserId),
        inArray(pins.agentProfileId, projectProfileIds(db, projectId))
      )
    );
  return Number(row?.count ?? 0);
}

export async function deleteProjectProfilePins(
  db: AppDb,
  projectId: string,
  memberUserId: string
): Promise<number> {
  const pins = schema.ccProfileAttachments;
  const removed = await db
    .delete(pins)
    .where(
      and(
        eq(pins.userId, memberUserId),
        inArray(pins.agentProfileId, projectProfileIds(db, projectId))
      )
    )
    .returning({ id: pins.id });
  return removed.length;
}
