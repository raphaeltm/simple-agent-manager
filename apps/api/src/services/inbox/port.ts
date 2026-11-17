/**
 * The worker side of the inbox (`OperationInboxPort`, `packages/operations/src/ports.ts`). Every
 * method delegates to the path its store already uses; nothing here answers a store a second way.
 */
import { OperationError, type OperationInboxPort } from '@simple-agent-manager/operations';
import { maybeJsonRecord } from '@simple-agent-manager/worker-core';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { retrySubtask } from '../../durable-objects/sam-session/tools/retry-subtask';
import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import {
  hasProjectCapability,
  projectMemberRolesWithCapability,
} from '../../middleware/project-auth';
import { archiveAttention, loadAttentionForViewer } from '../../routes/chat-attention';
import { authorizeAgentWake } from '../agent-wake-authorization';
import { decideOperationsAction } from '../operations-actions/service';
import * as projectDataService from '../project-data';
import { resolverDisplayName } from '../runtime-secret-request-records';
import {
  declineRuntimeSecretRequest,
  fulfillRuntimeSecretRequest,
} from '../runtime-secret-requests';
import { ensureSessionRecovery } from '../session-recovery';
import { clearTriggerPageCaches } from '../trigger-cache';
import { triggerStatusUpdates } from '../trigger-status';
import {
  announceAgentAsk,
  announceQuestionArchived,
  checkAgentLinkTargets,
  withdrawAgentQuestion,
} from './agent-asks';
import { readAskContext } from './ask-context';
import { deliverInboxAskNotice } from './ask-notice';

function metadataFields(metadata: string | null) {
  const empty = {
    options: [] as string[],
    category: null,
    interactionId: null,
    interactionKind: null,
  };
  if (!metadata) return empty;
  try {
    const record = maybeJsonRecord(JSON.parse(metadata) as unknown);
    if (!record) return empty;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    return {
      options: Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === 'string')
        : [],
      category: text(record.category),
      interactionId: text(record.interactionId),
      interactionKind: record.source === 'acp_interaction' ? text(record.kind) : null,
    };
  } catch {
    return empty;
  }
}

/** Only an active superadmin may decide an Operations approval (`admin-operations-approvals.ts`). */
async function requireActiveSuperadmin(env: Env, userId: string): Promise<void> {
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS ok FROM users WHERE id = ? AND role = 'superadmin' AND status = 'active'`
  )
    .bind(userId)
    .first();
  if (!row) throw errors.forbidden('Active superadmin access required');
}

export function createInboxPort(env: Env): OperationInboxPort {
  const db = () => drizzle(env.DATABASE, { schema });
  return {
    rolesWithCapability: (capability) => projectMemberRolesWithCapability(capability),

    async attentionMarker(projectId, sessionId, markerId, userId) {
      const viewer = await loadAttentionForViewer(env, projectId, sessionId, markerId, userId);
      if (!viewer.session || !viewer.marker) return null;
      const marker = viewer.marker;
      return {
        id: marker.id,
        sessionId: marker.sessionId,
        taskId: marker.taskId,
        source: marker.source,
        reason: marker.reason,
        ...metadataFields(marker.metadata),
        createdAt: marker.createdAt,
        expiresAt: marker.expiresAt,
        resolvedAt: marker.resolvedAt,
        topic: typeof viewer.session.topic === 'string' ? viewer.session.topic : null,
        canRead: viewer.canRead,
        canWrite: viewer.writer && viewer.canRead,
      };
    },

    async context({ projectId, sessionId, askedAt, userId }) {
      // The transcript is for readers of the source chat only (spec section 3.5).
      const access = await loadSessionReadAccess(env, projectId, sessionId, userId);
      if (!access) return null;
      return readAskContext(env, { projectId, sessionId, askedAt });
    },

    archiveAttention: (userId, projectId, sessionId, markerId) =>
      archiveAttention(env, userId, projectId, sessionId, markerId),

    async fulfilSecret(userId, projectId, requestId, secret) {
      const database = db();
      const result = await fulfillRuntimeSecretRequest(env, database, {
        projectId,
        requestId,
        actorUserId: userId,
        actorName: await resolverDisplayName(database, userId),
        ...secret,
      });
      return { agentNotified: result.agentNotified };
    },

    async declineSecret(userId, projectId, requestId) {
      const database = db();
      const result = await declineRuntimeSecretRequest(env, database, {
        projectId,
        requestId,
        actorUserId: userId,
        actorName: await resolverDisplayName(database, userId),
      });
      return { agentNotified: result.agentNotified };
    },

    async decideApproval(userId, approvalId, decision, note) {
      await requireActiveSuperadmin(env, userId);
      const outcome = await decideOperationsAction(env, {
        approvalId,
        decision,
        deciderUserId: userId,
        note: note?.trim() || null,
      });
      if (outcome.outcome === 'not_found') throw errors.notFound('Inbox item');
      if (outcome.outcome !== 'decided') {
        throw errors.conflict(
          outcome.outcome === 'expired'
            ? 'This request expired before it was decided'
            : `This request was already ${outcome.approval.status}`
        );
      }
      return { outcome: outcome.approval.status, agentNotified: outcome.delivered };
    },

    async authorizeAnswerWake(projectId, sessionId, userId) {
      await authorizeAgentWake(env, {
        projectId,
        sessionId,
        actorUserId: userId,
        trigger: 'attention_answer',
        action: 'answer the agent in this session',
      });
    },

    notifyAsk: (row, outcome) => deliverInboxAskNotice(env, row, outcome),

    async retryTask(userId, projectId, taskId) {
      // The existing retry: a new task with the same description, owner-only (`retrySubtask`).
      const owned = await env.DATABASE.prepare(
        'SELECT 1 AS ok FROM tasks WHERE id = ? AND project_id = ?'
      )
        .bind(taskId, projectId)
        .first();
      if (!owned) throw new OperationError('not_found', 'Task not found');
      const result = (await retrySubtask(
        { taskId },
        {
          env: env as unknown as Record<string, unknown>,
          userId,
        }
      )) as { newTaskId?: unknown; error?: unknown };
      if (typeof result.newTaskId !== 'string') {
        throw new OperationError(
          'conflict',
          typeof result.error === 'string' ? result.error : 'The task could not be retried'
        );
      }
      return { newTaskId: result.newTaskId };
    },

    async resumeTrigger(userId, projectId, triggerId) {
      const database = db();
      if (!(await hasProjectCapability(database, projectId, userId, 'task:write')))
        throw new OperationError('forbidden', 'You cannot resume automations in this project');
      const trigger = await database
        .select()
        .from(schema.triggers)
        .where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, projectId)))
        .get();
      if (!trigger) throw new OperationError('not_found', 'Automation not found');
      if (trigger.status !== 'paused')
        throw new OperationError('conflict', `This automation is ${trigger.status}, not paused`);
      // The trigger PATCH route's status change, as a compare-and-set on `paused`.
      const updated = await database
        .update(schema.triggers)
        .set({ ...triggerStatusUpdates(trigger, 'active'), updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.triggers.id, triggerId),
            eq(schema.triggers.projectId, projectId),
            eq(schema.triggers.status, 'paused')
          )
        )
        .returning({ id: schema.triggers.id });
      if (updated.length !== 1)
        throw new OperationError('conflict', 'The automation changed while it was being resumed');
      clearTriggerPageCaches(projectId);
    },

    async wakeChat(userId, projectId, sessionId) {
      await authorizeAgentWake(env, {
        projectId,
        sessionId,
        actorUserId: userId,
        trigger: 'user_followup',
        action: 'wake the agent in this session',
      });
      const result = await ensureSessionRecovery(env, projectId, sessionId);
      if (result.status !== 'waking') {
        // The refusal reason is a fixed code (`recordSessionRecoveryRefusal`), not error text.
        throw new OperationError(
          'conflict',
          result.reason === 'container_runtime_wakes_in_place'
            ? 'This chat wakes when you send it a message'
            : `SAM could not wake this chat (${result.reason})`
        );
      }
    },
    announceAsk: (input) => announceAgentAsk(env, input),

    withdrawQuestion: (input) => withdrawAgentQuestion(env, input),
    questionArchived: (input) => announceQuestionArchived(env, input),

    checkLinkTargets: (projectId, links) => checkAgentLinkTargets(env, projectId, links),
  };
}

/**
 * Whether the reader may read the chat: a project member with `task:read` reads any chat of the
 * project (owner, grantee or reader, `toSessionViewerAccess`), the rule the attention and comment
 * context reads apply.
 */
async function loadSessionReadAccess(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string
): Promise<boolean> {
  const database = drizzle(env.DATABASE, { schema });
  if (!(await hasProjectCapability(database, projectId, userId, 'task:read'))) return false;
  const { session, access } = await projectDataService.getSessionAccess(
    env,
    projectId,
    sessionId,
    userId
  );
  return Boolean(session) && access.found;
}
