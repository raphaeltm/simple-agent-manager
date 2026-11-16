/**
 * API-side entry to the agent-wake policy (`lib/agent-wake-policy.ts`).
 *
 * Resolves the actor's session access through `requireSessionWriter` (which also confirms a
 * grantee and the owner are still project members) and asks the policy. Callers get back
 * both the writer context they already used for resource resolution and the wake grant they
 * must record on the delivery.
 */
import type { Env } from '../env';
import {
  type AgentWakeGrant,
  type AgentWakeTrigger,
  decideAgentWake,
} from '../lib/agent-wake-policy';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import type { AppDb } from '../middleware/project-auth';
import { getSessionAccess } from './project-data';
import { requireSessionWriter, type SessionWriterContext } from './session-access';

export interface AuthorizeAgentWakeInput {
  projectId: string;
  sessionId: string;
  actorUserId: string;
  trigger: AgentWakeTrigger;
  db?: AppDb;
  /** Short label for logs and errors, e.g. "send comments to the agent in this session". */
  action: string;
}

export interface AuthorizedAgentWake {
  writer: SessionWriterContext;
  wake: AgentWakeGrant;
}

export async function authorizeAgentWake(
  env: Env,
  input: AuthorizeAgentWakeInput
): Promise<AuthorizedAgentWake> {
  const writer = await requireSessionWriter(
    env,
    input.projectId,
    input.sessionId,
    input.actorUserId,
    { db: input.db, action: input.action }
  );
  const decision = decideAgentWake({
    trigger: input.trigger,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    access: { role: writer.role, ownerUserId: writer.ownerUserId, grantId: writer.grantId },
  });
  if (!decision.allowed) {
    log.warn('agent_wake.denied', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      ownerUserId: writer.ownerUserId,
      trigger: decision.trigger,
      mode: decision.mode,
      reason: decision.reason,
      action: 'rejected',
    });
    throw errors.forbidden(`You cannot ${input.action}`);
  }
  return { writer, wake: decision };
}

/**
 * Whether a person's comment on a human task may wake the chat that assigned it (inbox slice H1,
 * trigger `inbox_task_comment`). Unlike `authorizeAgentWake` it never throws: a refused comment is
 * still recorded, it just does not wake the agent.
 *
 * Allowed: the task's assignee or the member who took it, and a writer of the filing chat (its
 * owner, or an active grantee who is still a member, as `requireSessionWriter` checks). Everyone
 * else, a chat that no longer exists, and an owner who left the project: no wake.
 */
export async function decideInboxTaskCommentWake(
  env: Env,
  input: {
    projectId: string;
    sessionId: string | null;
    actorUserId: string;
    assigneeUserId: string | null;
    claimedByUserId: string | null;
  }
): Promise<{ wake: boolean; teammateInput: boolean; reason: string }> {
  if (!input.sessionId) return { wake: false, teammateInput: false, reason: 'no_filing_chat' };
  try {
    const { access } = await getSessionAccess(
      env,
      input.projectId,
      input.sessionId,
      input.actorUserId
    );
    if (!access.found || !access.ownerUserId)
      return { wake: false, teammateInput: false, reason: 'filing_chat_missing' };
    // Both the author and the chat's owner must still be active members (every role reads tasks).
    // One query for both: `IN` holds one id when the owner comments.
    const members = await env.DATABASE.prepare(
      `SELECT user_id FROM project_members
        WHERE project_id = ? AND status = 'active' AND user_id IN (?, ?)`
    )
      .bind(input.projectId, input.actorUserId, access.ownerUserId)
      .all<{ user_id: string }>();
    const active = new Set((members.results ?? []).map((row) => row.user_id));
    if (!active.has(input.actorUserId) || !active.has(access.ownerUserId))
      return { wake: false, teammateInput: false, reason: 'not_a_member' };
    const decision = decideAgentWake({
      trigger: 'inbox_task_comment',
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      access: {
        role: access.role === 'owner' || access.role === 'grantee' ? access.role : 'none',
        ownerUserId: access.ownerUserId,
        grantId: access.role === 'grantee' ? (access.grant?.id ?? null) : null,
      },
      inboxTask: { assigneeUserId: input.assigneeUserId, claimedByUserId: input.claimedByUserId },
    });
    if (!decision.allowed) {
      log.info('agent_wake.inbox_task_comment_recorded_only', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        reason: decision.reason,
      });
      return { wake: false, teammateInput: false, reason: decision.reason };
    }
    return { wake: true, teammateInput: decision.teammateInput, reason: decision.actorRole };
  } catch (error) {
    // An unknown answer must not wake someone else's agent: record only.
    log.warn('agent_wake.inbox_task_comment_decision_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { wake: false, teammateInput: false, reason: 'decision_failed' };
  }
}
