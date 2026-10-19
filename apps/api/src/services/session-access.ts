/**
 * Server-side authority for session-scoped actions (idea 01M59MYE4GY91BWTE8TZF1ZB5D).
 *
 * Every route or operation that lets a person drive one chat session — prompt, cancel, stop,
 * answer an agent, send a comment to the agent, sleep, resume — goes through
 * `requireSessionWriter`. It returns two identities and callers must keep them apart:
 *
 * - `actorUserId` — the person acting. Used ONLY for attribution: transcript sender, comment
 *   `sentBy`, activity and task-status actor fields, notifications.
 * - `ownerUserId` — the session owner (`chat_sessions.created_by_user_id`). Used ONLY for
 *   resource and credential resolution: the workspace, node, task and agent-session rows, the
 *   agent credential, compute billing. A grantee's own id never selects a resource.
 *
 * Product rule (Raphaël, 2026-10-19): once the owner shares a session, the grantee drives it
 * exactly as the owner would — no further checks beyond both people staying active project
 * members. The grantee does not need their own repository access: the owner's grant is the
 * consent to act through the owner's session.
 *
 * Preconditions: the caller has already checked the actor's project capability
 * (`requireProjectCapability`) for the request. Grantee requests are re-checked here anyway,
 * because a grantee's authority exists only while they, and the owner, remain members.
 */
import type { SessionViewerAccess } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { SessionAccessResolution } from '../durable-objects/project-data/session-access';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { type AppDb, hasProjectCapability } from '../middleware/project-auth';
import * as projectDataService from './project-data';

export type SessionWriterRole = 'owner' | 'grantee';

export interface SessionWriterContext {
  projectId: string;
  sessionId: string;
  /** The session row (same shape as `projectDataService.getSession`). */
  session: Record<string, unknown>;
  role: SessionWriterRole;
  /** The person acting. Attribution only. */
  actorUserId: string;
  /** The session owner. Resource and credential resolution only. */
  ownerUserId: string;
  /** The actor's own grant when `role === 'grantee'`. */
  grantId: string | null;
}

export interface RequireSessionWriterOptions {
  db?: AppDb;
  /** Short label for logs and errors, e.g. "send messages", "stop this session". */
  action?: string;
}

/** Map the ProjectData resolution to the viewer-facing access level. */
export function toSessionViewerAccess(access: SessionAccessResolution): SessionViewerAccess {
  if (access.role === 'owner') return 'owner';
  if (access.role === 'grantee') return 'grantee';
  return 'reader';
}

function rejected(
  context: {
    projectId: string;
    sessionId: string;
    actorUserId: string;
    ownerUserId: string | null;
    action: string;
  },
  reason: string
): void {
  log.warn('session_access.writer_rejected', { ...context, reason, outcome: 'rejected' });
}

export async function requireSessionWriter(
  env: Env,
  projectId: string,
  sessionId: string,
  actorUserId: string,
  options: RequireSessionWriterOptions = {}
): Promise<SessionWriterContext> {
  const action = options.action ?? 'control this session';
  const { session, access } = await projectDataService.getSessionAccess(
    env,
    projectId,
    sessionId,
    actorUserId
  );
  if (!access.found || !session) throw errors.notFound('Chat session');

  const logContext = {
    projectId,
    sessionId,
    actorUserId,
    ownerUserId: access.ownerUserId,
    action,
  };

  if (access.role === 'owner' && access.ownerUserId) {
    return {
      projectId,
      sessionId,
      session,
      role: 'owner',
      actorUserId,
      ownerUserId: access.ownerUserId,
      grantId: null,
    };
  }

  if (access.role !== 'grantee' || !access.grant || !access.ownerUserId) {
    rejected(logContext, 'not_owner_or_grantee');
    throw errors.forbidden(`Only the session owner or someone they shared it with can ${action}`);
  }

  const db = options.db ?? drizzle(env.DATABASE, { schema });
  const [actorIsMember, ownerIsMember] = await Promise.all([
    hasProjectCapability(db, projectId, actorUserId, 'task:write'),
    hasProjectCapability(db, projectId, access.ownerUserId, 'task:write'),
  ]);
  if (!actorIsMember) {
    rejected(logContext, 'grantee_not_member');
    throw errors.forbidden('Project capability is required');
  }
  if (!ownerIsMember) {
    rejected(logContext, 'owner_not_member');
    throw errors.forbidden('The owner of this session is no longer a member of this project');
  }

  return {
    projectId,
    sessionId,
    session,
    role: 'grantee',
    actorUserId,
    ownerUserId: access.ownerUserId,
    grantId: access.grant.id,
  };
}

/**
 * The interaction store and attention markers record the decision, not the person. When
 * someone other than the owner answers the agent in a shared session, record who did.
 * Best-effort: the answer is already delivered, so a failed audit write must not turn it
 * into an error.
 */
export async function recordSharedSessionAnswer(
  env: Env,
  writer: SessionWriterContext,
  detail: Record<string, unknown>
): Promise<void> {
  if (writer.role !== 'grantee') return;
  try {
    await projectDataService.recordActivityEvent(
      env,
      writer.projectId,
      'session.shared_answer',
      'user',
      writer.actorUserId,
      null,
      writer.sessionId,
      null,
      { ...detail, ownerUserId: writer.ownerUserId, grantId: writer.grantId }
    );
  } catch (err) {
    log.warn('session_access.shared_answer_audit_failed', {
      projectId: writer.projectId,
      sessionId: writer.sessionId,
      actorUserId: writer.actorUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Membership ended (offboarding apply): revoke every grant the person held and every grant on
 * sessions they own. Per-request membership checks already fail closed; this removes the
 * stored grants so a later re-approval does not bring them back.
 */
export async function revokeSessionAccessForDepartedMember(
  env: Env,
  projectId: string,
  userId: string
): Promise<void> {
  try {
    const revoked = await projectDataService.revokeSessionAccessForDepartedMember(
      env,
      projectId,
      userId
    );
    log.info('session_access.departed_member_revoked', {
      projectId,
      userId,
      sessions: revoked.length,
      grants: revoked.reduce((sum, entry) => sum + entry.revokedGrants.length, 0),
    });
  } catch (err) {
    log.error('session_access.departed_member_revoke_failed', {
      projectId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
