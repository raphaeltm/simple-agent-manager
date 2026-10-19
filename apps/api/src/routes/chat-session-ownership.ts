import type {
  SessionAccessGrant,
  SessionAccessPerson,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type {
  SessionAccessGrantRecord,
  SessionAccessResolution,
} from '../durable-objects/project-data/session-access';
import { errors } from '../middleware/error';
import { toSessionViewerAccess } from '../services/session-access';

type SessionCreator = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  avatarUrl: string | null;
};

async function buildCreatorMap(
  db: ReturnType<typeof drizzle<typeof schema>>,
  sessions: Array<Record<string, unknown>>,
  extraUserIds: readonly string[] = []
): Promise<Map<string, SessionCreator>> {
  const creatorIds = [
    ...new Set([
      ...sessions
        .map((session) => session.createdByUserId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ...extraUserIds,
    ]),
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
  const creator = creatorId ? (creators.get(creatorId) ?? null) : null;
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

function accessPerson(id: string, people: Map<string, SessionCreator>): SessionAccessPerson {
  const person = people.get(id);
  return {
    id,
    name: person?.name ?? person?.email?.split('@')[0] ?? null,
    avatarUrl: person?.avatarUrl ?? person?.image ?? null,
  };
}

/**
 * Attach the creator, the viewer's session access and the active shared-access grants to one
 * session, resolving every person the response names in a single users query.
 */
async function enrichSessionWithAccess(
  db: ReturnType<typeof drizzle<typeof schema>>,
  session: Record<string, unknown>,
  currentUserId: string,
  input: { access: SessionAccessResolution; grants: SessionAccessGrantRecord[] }
): Promise<Record<string, unknown>> {
  const people = await buildCreatorMap(
    db,
    [session],
    input.grants.flatMap((grant) => [grant.granteeUserId, grant.grantedByUserId])
  );
  const sessionId = typeof session.id === 'string' ? session.id : '';
  const viewerAccess = toSessionViewerAccess(input.access);
  // Active grants always carry an end time; a row without one is never active (fail closed).
  const grants: SessionAccessGrant[] = input.grants.flatMap((grant) =>
    grant.expiresAt === null
      ? []
      : [
          {
            id: grant.id,
            sessionId: grant.sessionId,
            grantee: accessPerson(grant.granteeUserId, people),
            grantedBy: accessPerson(grant.grantedByUserId, people),
            parentGrantId: grant.parentGrantId,
            createdAt: grant.createdAt,
            expiresAt: grant.expiresAt,
            durationMinutes: grant.durationMinutes ?? 0,
          },
        ]
  );
  const access: SessionAccessSummary = {
    sessionId,
    viewerAccess,
    owner: input.access.ownerUserId ? accessPerson(input.access.ownerUserId, people) : null,
    grants,
    serverTime: Date.now(),
  };
  return { ...attachCreator(session, people, currentUserId), viewerAccess, access };
}

export { enrichSessionsWithCreators, enrichSessionWithAccess, getSessionListScope };
