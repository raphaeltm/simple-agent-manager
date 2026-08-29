import { log } from '../../lib/logger';
import {
  resolveVmAdmissionScope,
  type VmAdmissionWait,
  type VmProvisioningLeaseResult,
  type VmTaskAdmissionIdentity,
} from '../../services/vm-admission-control';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function scheduleAdmissionWait(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  result: VmAdmissionWait
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'waiting_for_node_capacity');
  await rc.ctx.storage.put('state', state);
  const nextRetryMs = Date.parse(result.nextRetryAt);
  await rc.ctx.storage.setAlarm(Number.isFinite(nextRetryMs) ? nextRetryMs : Date.now());
  log.info('task_runner_do.node_provisioning.admission_wait', {
    taskId: state.taskId,
    reason: result.reason,
    nextRetryAt: result.nextRetryAt,
    waitDeadlineAt: result.waitDeadlineAt,
  });
}

export async function handleLeaseResult(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  result: VmProvisioningLeaseResult
): Promise<'granted' | 'waiting'> {
  if (result.kind === 'expired') {
    throw Object.assign(new Error('Timed out waiting for VM capacity'), { permanent: true });
  }
  if (result.kind === 'waiting') {
    await scheduleAdmissionWait(state, rc, result);
    return 'waiting';
  }
  state.admissionScopeKey = result.scopeKey;
  state.admissionLeaseToken = result.fencingToken > 0 ? result.fencingToken : null;
  await rc.ctx.storage.put('state', state);
  return 'granted';
}

export async function buildAdmissionIdentity(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<VmTaskAdmissionIdentity | null> {
  const scope = await resolveVmAdmissionScope(rc.env, {
    userId: state.userId,
    projectId: state.projectId,
    targetProvider: state.config.cloudProvider,
    credentialAttributionUserId: state.config.credentialAttributionUserId,
    credentialAttributionProjectId: state.config.credentialAttributionProjectId,
    credentialAttributionSource: state.config.credentialAttributionSource,
  });
  if (!scope) return null;
  return {
    ...scope,
    taskId: state.taskId,
    projectId: state.projectId,
    userId: state.userId,
    requestedVmSize: state.config.vmSize,
    requestedVmLocation: state.config.vmLocation,
    preferredNodeId: state.config.preferredNodeId,
  };
}
