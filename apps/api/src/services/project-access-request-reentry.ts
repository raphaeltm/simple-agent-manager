import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';

interface ReentryInput {
  db: DrizzleD1Database<typeof schema>;
  projectId: string;
  requesterUserId: string;
}

async function loadPendingRequest(input: ReentryInput): Promise<string> {
  const rows = await input.db
    .select()
    .from(schema.projectAccessRequests)
    .where(
      and(
        eq(schema.projectAccessRequests.projectId, input.projectId),
        eq(schema.projectAccessRequests.requesterUserId, input.requesterUserId)
      )
    )
    .limit(1);
  if (rows[0]?.status === 'pending') return rows[0].id;
  throw errors.conflict('Access request state changed; reload the invite');
}

export async function resolveConcurrentAccessRequest(input: ReentryInput): Promise<string> {
  const memberRows = await input.db
    .select()
    .from(schema.projectMembers)
    .where(
      and(
        eq(schema.projectMembers.projectId, input.projectId),
        eq(schema.projectMembers.userId, input.requesterUserId),
        eq(schema.projectMembers.status, 'active')
      )
    )
    .limit(1);
  if (memberRows[0]) throw errors.conflict('You are already a member of this project');
  return loadPendingRequest(input);
}

export const resolveConcurrentRequestInsert = loadPendingRequest;

export function inviteMembershipStatus(
  activeMembership: boolean,
  requestStatus: string | undefined
): 'active-member' | 'pending-request' | 'denied-request' | 'can-request' {
  if (activeMembership) return 'active-member';
  if (requestStatus === 'pending') return 'pending-request';
  if (requestStatus === 'denied') return 'denied-request';
  return 'can-request';
}
