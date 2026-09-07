import { isSessionRecoverySourceTaskGuardValid } from '../../services/session-recovery-authority';
import { requireScheduleMember } from './project-event-schedules-authority';
import { getSchedule } from './project-event-schedules-storage';
import { ProjectEventValidationError } from './project-events-contracts';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

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
  try {
    await requireScheduleMember(env, projectId, schedule.creatorUserId);
    if (
      !(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, {
        projectId,
        taskId: claim.message.sourceTaskId,
        chatSessionId: claim.message.targetSessionId,
        requiredProjectMemberId: schedule.creatorUserId,
      }))
    )
      return invalid();
    return local() ? null : invalid();
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
