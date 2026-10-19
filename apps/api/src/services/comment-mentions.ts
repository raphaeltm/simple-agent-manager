/**
 * Structured @mentions of people in message comments (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * The client sends user IDs it picked from the member list. Only IDs that belong to ACTIVE
 * members of the same project survive; anything else silently stays plain text in the body.
 * Display names are snapshotted here, never taken from the client.
 */
import type { CommentMention, CommentMentionInput } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getCommentMentionsMax } from './collaboration-settings';

type Db = ReturnType<typeof drizzle<typeof schema>>;

function mentionLabel(row: { name: string | null; email: string | null }): string | null {
  return row.name?.trim() || row.email?.split('@')[0] || null;
}

export async function resolveCommentMentions(
  env: Env,
  db: Db,
  projectId: string,
  inputs: readonly CommentMentionInput[] | undefined
): Promise<CommentMention[]> {
  if (!inputs || inputs.length === 0) return [];
  const requested = [...new Set(inputs.map((input) => input.userId.trim()).filter(Boolean))];
  if (requested.length === 0) return [];
  const max = await getCommentMentionsMax(env);
  if (requested.length > max) {
    throw errors.badRequest(`A comment can mention at most ${max} people`);
  }

  const rows = await db
    .select({
      userId: schema.projectMembers.userId,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.projectMembers)
    .innerJoin(schema.users, eq(schema.projectMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.projectMembers.projectId, projectId),
        eq(schema.projectMembers.status, 'active'),
        inArray(schema.projectMembers.userId, requested)
      )
    );
  const byId = new Map(rows.map((row) => [row.userId, row]));
  // Keep the order the author picked them in.
  return requested.flatMap((userId) => {
    const row = byId.get(userId);
    return row ? [{ userId, displayName: mentionLabel(row) }] : [];
  });
}
