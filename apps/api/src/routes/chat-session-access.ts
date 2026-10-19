/**
 * Shared session access ("Share chat access") — idea 01M59MYE4GY91BWTE8TZF1ZB5D.
 *
 * GET    /api/projects/:projectId/sessions/:sessionId/access
 * POST   /api/projects/:projectId/sessions/:sessionId/access/grants        { userId, acknowledgeSharedCredentials: true }
 * DELETE /api/projects/:projectId/sessions/:sessionId/access/grants/:userId
 *
 * Any project member can read who has access. The owner or an active grantee can share the
 * session with another active member and remove anyone's grant (owner-equivalent control);
 * a grantee can always remove their own access. Removing a grant also removes the grants that
 * person issued, and fails their prompts that have not reached the agent yet.
 *
 * Sharing needs nothing beyond active membership: the grantee then drives the session exactly
 * as the owner would, on the owner's accounts (product rule, 2026-10-19).
 */
import type {
  CreateSessionAccessGrantResponse,
  RevokeSessionAccessGrantResponse,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { SessionAccessGrantRecord } from '../durable-objects/project-data/session-access';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { resolveWaitUntil } from '../lib/wait-until';
import { getAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { hasProjectCapability, requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas/_validator';
import { notifySessionAccessChange } from '../services/collaboration-notifications';
import { getSessionAccessMaxGrants } from '../services/collaboration-settings';
import * as projectDataService from '../services/project-data';
import { requireSessionWriter } from '../services/session-access';
import { enrichSessionWithAccess } from './chat-session-ownership';

const CreateGrantSchema = v.object({
  userId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  acknowledgeSharedCredentials: v.literal(
    true,
    'Confirm that the session runs on the owner’s accounts'
  ),
});

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function accessSummary(
  db: Db,
  session: Record<string, unknown>,
  viewerUserId: string,
  access: Awaited<ReturnType<typeof projectDataService.getSessionAccess>>['access'],
  grants: SessionAccessGrantRecord[]
): Promise<SessionAccessSummary> {
  const enriched = await enrichSessionWithAccess(db, session, viewerUserId, { access, grants });
  return enriched.access as SessionAccessSummary;
}

function sessionTopic(session: Record<string, unknown>): string | null {
  return typeof session.topic === 'string' ? session.topic : null;
}

function notifyInBackground(c: Context<{ Bindings: Env }>, work: Promise<void>, event: string) {
  resolveWaitUntil(
    c,
    event
  )(
    work.catch((err) => {
      log.warn(event, { error: err instanceof Error ? err.message : String(err) });
    })
  );
}

export function registerChatSessionAccessRoutes(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.get('/:sessionId/access', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'task:read');

    const loaded = await projectDataService.getSessionWithAccessGrants(
      c.env,
      projectId,
      sessionId,
      userId
    );
    if (!loaded.session) throw errors.notFound('Chat session');
    return c.json(await accessSummary(db, loaded.session, userId, loaded.access, loaded.grants));
  });

  chatRoutes.post('/:sessionId/access/grants', jsonValidator(CreateGrantSchema), async (c) => {
    const actorUserId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const { userId: granteeUserId } = c.req.valid('json');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, actorUserId, 'task:write');
    const writer = await requireSessionWriter(c.env, projectId, sessionId, actorUserId, {
      db,
      action: 'share this session',
    });
    if (granteeUserId === writer.ownerUserId) {
      throw errors.badRequest('The session owner already controls this session');
    }

    // The grantee must be an active member who can work on tasks in this project. Nothing
    // else is required: sharing is the owner's consent to let them drive this session.
    if (!(await hasProjectCapability(db, projectId, granteeUserId, 'task:write'))) {
      throw errors.badRequest(
        'Only active project members who can run tasks can be added to a session'
      );
    }
    const maxActiveGrants = await getSessionAccessMaxGrants(c.env);
    const { result, grants } = await projectDataService.createSessionAccessGrant(c.env, projectId, {
      sessionId,
      granteeUserId,
      grantedByUserId: actorUserId,
      maxActiveGrants,
    });
    switch (result.status) {
      case 'session_not_found':
        throw errors.notFound('Chat session');
      case 'forbidden':
        throw errors.forbidden(result.reason);
      case 'invalid':
        throw errors.badRequest(result.reason);
      case 'limit_exceeded':
        throw errors.conflict(
          `A session can be shared with at most ${result.limit} people at a time`
        );
      default:
        break;
    }

    const summary = await accessSummary(
      db,
      writer.session,
      actorUserId,
      {
        found: true,
        ownerUserId: writer.ownerUserId,
        sessionStatus: typeof writer.session.status === 'string' ? writer.session.status : null,
        role: writer.role,
        grant: null,
      },
      grants
    );
    if (result.status === 'created') {
      const grantee = summary.grants.find((grant) => grant.grantee.id === granteeUserId);
      notifyInBackground(
        c,
        notifySessionAccessChange(c.env, {
          projectId,
          sessionId,
          sessionTopic: sessionTopic(writer.session),
          sessionOwnerUserId: writer.ownerUserId,
          actor: { userId: actorUserId, name: getAuth(c).user.name ?? null },
          change: 'granted',
          affectedUserIds: [granteeUserId],
          granteeName: grantee?.grantee.name ?? null,
        }),
        'session_access.grant_notification_failed'
      );
    }
    const grant = summary.grants.find((candidate) => candidate.id === result.grant.id);
    if (!grant) throw errors.internal('Created grant was not readable');
    const response: CreateSessionAccessGrantResponse = {
      grant,
      created: result.status === 'created',
      access: summary,
    };
    return c.json(response, result.status === 'created' ? 201 : 200);
  });

  chatRoutes.delete('/:sessionId/access/grants/:granteeUserId', async (c) => {
    const actorUserId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const granteeUserId = requireRouteParam(c, 'granteeUserId');
    const db = drizzle(c.env.DATABASE, { schema });

    const leaving = granteeUserId === actorUserId;
    await requireProjectCapability(
      db,
      projectId,
      actorUserId,
      leaving ? 'task:read' : 'task:write'
    );
    // A grantee can always leave; removing someone else needs session control.
    const writer = leaving
      ? null
      : await requireSessionWriter(c.env, projectId, sessionId, actorUserId, {
          db,
          action: 'remove access to this session',
        });

    const { result, grants } = await projectDataService.revokeSessionAccessGrant(c.env, projectId, {
      sessionId,
      granteeUserId,
      actorUserId,
    });
    switch (result.status) {
      case 'session_not_found':
        throw errors.notFound('Chat session');
      case 'forbidden':
        throw errors.forbidden(result.reason);
      case 'not_granted':
        throw errors.notFound('Shared access for this person');
      default:
        break;
    }

    const loaded = await projectDataService.getSessionAccess(
      c.env,
      projectId,
      sessionId,
      actorUserId
    );
    if (!loaded.session) throw errors.notFound('Chat session');
    const summary = await accessSummary(db, loaded.session, actorUserId, loaded.access, grants);
    notifyInBackground(
      c,
      notifySessionAccessChange(c.env, {
        projectId,
        sessionId,
        sessionTopic: sessionTopic(loaded.session),
        sessionOwnerUserId: writer?.ownerUserId ?? loaded.access.ownerUserId,
        actor: { userId: actorUserId, name: getAuth(c).user.name ?? null },
        change: 'revoked',
        affectedUserIds: result.revokedGrants.map((grant) => grant.granteeUserId),
        granteeName: null,
      }),
      'session_access.revoke_notification_failed'
    );
    const response: RevokeSessionAccessGrantResponse = {
      revokedGrantIds: result.revokedGrants.map((grant) => grant.id),
      cancelledDeliveryIds: result.cancelledDeliveryIds,
      access: summary,
    };
    return c.json(response);
  });
}
