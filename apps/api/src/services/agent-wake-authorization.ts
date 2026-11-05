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
