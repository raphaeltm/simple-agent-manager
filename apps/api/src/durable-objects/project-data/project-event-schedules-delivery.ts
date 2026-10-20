import { parseProviderLimitWait } from '../../services/provider-limit-policy';
import { isSessionRecoverySourceTaskGuardValid } from '../../services/session-recovery-authority';
import { requireScheduleMember } from './project-event-schedules-authority';
import { getSchedule, scheduleSharedAccessGrantId } from './project-event-schedules-storage';
import { ProjectEventValidationError } from './project-events-contracts';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import {
  grantEndedReason,
  labelUndeliveredPrompt,
  SENDER_ACCESS_ENDED_ERRORS,
} from './session-access-store';
import type { Env } from './types';

/**
 * A teammate's scheduled message is delivered only while the grant it was made under is active
 * (idea 01M59MYE4GY91BWTE8TZF1ZB5D), the same fence their typed messages pass before every side
 * effect. Only submit claims: a reconcile reads the receipt of a prompt already handed over.
 */
function scheduledSenderAccessEnded(
  sql: SqlStorage,
  projectId: string,
  scheduleId: string,
  creatorUserId: string,
  claim: PromptDeliveryClaim
): PromptDeliveryResult | null {
  if (claim.mode !== 'submit') return null;
  const grantId = scheduleSharedAccessGrantId(sql, projectId, scheduleId);
  if (!grantId) return null;
  const ended = grantEndedReason(
    sql,
    claim.message.targetSessionId,
    creatorUserId,
    grantId,
    Date.now()
  );
  if (!ended) return null;
  if (claim.message.promptMessageId) {
    labelUndeliveredPrompt(
      sql,
      claim.message.targetSessionId,
      claim.message.promptMessageId,
      ended
    );
  }
  return {
    kind: 'failed',
    reason: 'sender_unauthorized',
    error: SENDER_ACCESS_ENDED_ERRORS[ended],
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  };
}

export async function invalidScheduledDeliveryTarget(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim
): Promise<PromptDeliveryResult | null> {
  if (claim.message.sourceKind !== 'scheduled_action') return null;
  const scheduleId = claim.message.metadata?.scheduleId;
  const invalid = (): PromptDeliveryResult => ({
    kind: 'failed',
    reason: 'terminal_target',
    error: 'Scheduled action or target authority is no longer valid',
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  });
  if (!projectId || typeof scheduleId !== 'string' || !claim.message.sourceTaskId) return invalid();
  const local = () => {
    const schedule = getSchedule(sql, projectId, scheduleId);
    if (
      !schedule ||
      schedule.state !== 'admitted' ||
      schedule.deliveryId !== claim.message.id ||
      schedule.action.kind !== 'message_session' ||
      schedule.action.sessionId !== claim.message.targetSessionId
    )
      return null;
    const target = sql
      .exec(`SELECT status FROM chat_sessions WHERE id = ?`, schedule.action.sessionId)
      .toArray()[0];
    return target && (target.status === 'active' || target.status === 'sleeping') ? schedule : null;
  };
  const schedule = local();
  if (!schedule) return invalid();
  const accessEnded = () =>
    scheduledSenderAccessEnded(sql, projectId, scheduleId, schedule.creatorUserId, claim);
  const ended = accessEnded();
  if (ended) return ended;
  try {
    await requireScheduleMember(env, projectId, schedule.creatorUserId);
    if (schedule.idempotencyKey.startsWith('provider-limit:')) {
      const task = await env.DATABASE.prepare(
        'SELECT provider_limit_wait_json FROM tasks WHERE id = ? AND project_id = ?'
      )
        .bind(claim.message.sourceTaskId, projectId)
        .first<{ provider_limit_wait_json: string | null }>();
      const wait = parseProviderLimitWait(task?.provider_limit_wait_json);
      if (!wait || wait.phase === 'blocked' || wait.scheduleKey !== schedule.idempotencyKey)
        return invalid();
    }

    if (
      !(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, {
        projectId,
        taskId: claim.message.sourceTaskId,
        chatSessionId: claim.message.targetSessionId,
        requiredProjectMemberId: schedule.creatorUserId,
      }))
    )
      return invalid();
    return local() ? accessEnded() : invalid();
  } catch (error) {
    if (error instanceof ProjectEventValidationError) return invalid();
    if (claim.mode === 'reconcile')
      return {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Scheduled action authority check unavailable during reconciliation',
        receipt: null,
        runtimeIdentity: claim.message.runtimeIdentity,
        capabilities: null,
      };
    return {
      kind: 'retry',
      reason: 'not_ready',
      error: 'Scheduled action authority check unavailable',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
}

/** Persist confirmed in-place resume before acknowledging its durable inbox delivery. */
export async function releaseAcceptedProviderLimitSchedule(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult
): Promise<void> {
  if (
    result.kind !== 'accepted' ||
    !result.receipt ||
    result.receipt.acceptedAt === null ||
    claim.message.sourceKind !== 'scheduled_action' ||
    !projectId ||
    !claim.message.sourceTaskId
  )
    return;
  const scheduleId = claim.message.metadata?.scheduleId;
  if (typeof scheduleId !== 'string') return;
  const schedule = getSchedule(sql, projectId, scheduleId);
  if (
    !schedule ||
    !schedule.idempotencyKey.startsWith('provider-limit:') ||
    schedule.state !== 'admitted' ||
    schedule.deliveryId !== claim.message.id ||
    schedule.action.kind !== 'message_session' ||
    schedule.action.sessionId !== claim.message.targetSessionId
  )
    return;
  const task = await env.DATABASE.prepare(
    'SELECT workspace_id,provider_limit_wait_json FROM tasks WHERE id=? AND project_id=? AND chat_session_id=?'
  )
    .bind(claim.message.sourceTaskId, projectId, claim.message.targetSessionId)
    .first<{ workspace_id: string | null; provider_limit_wait_json: string | null }>();
  const wait = parseProviderLimitWait(task?.provider_limit_wait_json);
  if (
    !task?.workspace_id ||
    !wait ||
    wait.phase !== 'waiting' ||
    wait.scheduleKey !== schedule.idempotencyKey ||
    wait.sourceAgentSessionId !== result.acpSessionId ||
    Date.now() < wait.nextRetryAt
  )
    return;
  const released = await env.DATABASE.prepare(
    `UPDATE tasks SET provider_limit_wait_json=json_set(provider_limit_wait_json,'$.phase','released'),admission_state=NULL,admission_reason=NULL,admission_next_retry_at=NULL
    WHERE id=? AND project_id=? AND chat_session_id=? AND workspace_id=? AND status IN ('delegated','in_progress') AND json_valid(provider_limit_wait_json) AND json_extract(provider_limit_wait_json,'$.phase')='waiting' AND json_extract(provider_limit_wait_json,'$.scheduleKey')=? AND json_extract(provider_limit_wait_json,'$.sourceAgentSessionId')=? AND json_extract(provider_limit_wait_json,'$.sourceCredentialGeneration')=?
    AND EXISTS(SELECT 1 FROM workspaces w JOIN nodes n ON n.id=w.node_id WHERE w.id=tasks.workspace_id AND w.project_id=tasks.project_id AND w.user_id=tasks.user_id AND w.status='running' AND n.status='running')
    AND EXISTS(SELECT 1 FROM agent_sessions a WHERE a.id=? AND a.workspace_id=tasks.workspace_id AND a.status='running' AND a.agent_credential_generation=?)
    AND (SELECT COUNT(*) FROM agent_sessions a WHERE a.workspace_id=tasks.workspace_id AND a.status='running')=1`
  )
    .bind(
      claim.message.sourceTaskId,
      projectId,
      claim.message.targetSessionId,
      task.workspace_id,
      wait.scheduleKey,
      wait.sourceAgentSessionId,
      wait.sourceCredentialGeneration,
      result.acpSessionId,
      wait.sourceCredentialGeneration
    )
    .run();
  if (!released.meta.changes) {
    const current = await env.DATABASE.prepare(
      'SELECT provider_limit_wait_json FROM tasks WHERE id=? AND project_id=?'
    )
      .bind(claim.message.sourceTaskId, projectId)
      .first<{ provider_limit_wait_json: string | null }>();
    const remaining = parseProviderLimitWait(current?.provider_limit_wait_json);
    if (remaining?.phase === 'waiting' && remaining.scheduleKey === wait.scheduleKey)
      throw new Error('Provider continuation acceptance checkpoint requires retry');
  }
}
