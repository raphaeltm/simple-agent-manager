import { inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import * as projectDataService from '../services/project-data';

type SessionCreator = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  avatarUrl: string | null;
};

async function buildCreatorMap(
  db: ReturnType<typeof drizzle<typeof schema>>,
  sessions: Array<Record<string, unknown>>
): Promise<Map<string, SessionCreator>> {
  const creatorIds = [
    ...new Set(
      sessions
        .map((session) => session.createdByUserId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];

  if (creatorIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      image: schema.users.image,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, creatorIds));

  return new Map(rows.map((row) => [row.id, row]));
}

function attachCreator(
  session: Record<string, unknown>,
  creators: Map<string, SessionCreator>,
  currentUserId: string
): Record<string, unknown> {
  const creatorId = typeof session.createdByUserId === 'string' ? session.createdByUserId : null;
  const creator = creatorId ? creators.get(creatorId) ?? null : null;
  return {
    ...session,
    createdBy: creator,
    isMine: creatorId === currentUserId,
  };
}

async function enrichSessionsWithCreators(
  db: ReturnType<typeof drizzle<typeof schema>>,
  sessions: Array<Record<string, unknown>>,
  currentUserId: string
): Promise<Array<Record<string, unknown>>> {
  const creators = await buildCreatorMap(db, sessions);
  return sessions.map((session) => attachCreator(session, creators, currentUserId));
}

function getSessionListScope(rawScope?: string): 'my' | 'all' {
  if (!rawScope) return 'all';
  const scope = rawScope.trim().toLowerCase();
  if (scope === 'my' || scope === 'all') return scope;
  throw errors.badRequest('scope must be my or all');
}

async function requireSessionCreator(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string
): Promise<Record<string, unknown>> {
  const session = await projectDataService.getSession(env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Chat session');
  }

  const creatorId = typeof session.createdByUserId === 'string' ? session.createdByUserId : null;
  if (creatorId !== userId) {
    throw errors.forbidden('Only the session creator can write to this chat session');
  }

  return session;
}

export {
  enrichSessionsWithCreators,
  getSessionListScope,
  requireSessionCreator,
};
