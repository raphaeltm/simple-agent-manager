import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import type { Actor } from '../operations/types';
import { hmacToken } from '../routes/api-tokens';
import { assertSessionUserApproved } from './signup-approval';

/** Verify the PAT itself on every call; never mint a reusable login session. */
export async function authenticateConnectorPat(rawToken: string, env: Env): Promise<Actor | null> {
  if (!rawToken.startsWith('sam_pat_')) return null;
  const db = drizzle(env.DATABASE, { schema });
  const token = await db
    .select()
    .from(schema.apiTokens)
    .where(
      and(
        eq(schema.apiTokens.tokenHash, await hmacToken(rawToken, env.ENCRYPTION_KEY)),
        isNull(schema.apiTokens.revokedAt)
      )
    )
    .get();
  if (!token) return null;
  await db
    .update(schema.apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiTokens.id, token.id));
  return {
    userId: token.userId,
    via: 'pat',
    clientId: token.id,
    clientName: 'API token',
    scopes: new Set(['sam.read', 'sam.write']),
  };
}

export async function assertConnectorUserActive(env: Env, actor: Actor): Promise<boolean> {
  const user = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, actor.userId))
    .get();
  if (!user || user.status === 'system') return false;
  await assertSessionUserApproved(env, user);
  return true;
}
