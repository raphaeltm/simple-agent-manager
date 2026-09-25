/**
 * Provider-allocation failure handling for one TaskRunner `node_provisioning`
 * attempt.
 *
 * Split out of `node-provisioning-step.ts` (rule 18). Decides what a failed
 * provider allocation means for the attempt chain, in this order:
 *
 *   1. A core quota with a smaller permitted offering left → descend to it
 *      (`node-provisioning-core-quota.ts`). No cooldown: a smaller server may
 *      still fit, for this task and for every other task in the domain.
 *   2. Any provider account quota → record the domain cooldown and park the
 *      task on `provider_account_capacity`; without an admission queue, fail
 *      with a message that says which limit was hit and what to do about it.
 *   3. Any other non-capacity failure → fail fast.
 *   4. Transient capacity → the next permitted offering, else the pool's
 *      exhaustion policy.
 */
import {
  classifyHetznerAccountLimit,
  type HetznerAccountLimit,
  isTransientCapacityError,
  ProviderError,
} from '@simple-agent-manager/providers';
import type { PlacementAttemptDiagnostic } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  describeProviderAccountLimit,
  getVmAdmissionConfig,
  recordVmProviderCapacityFailure,
  releaseVmProvisioningLease,
  type VmTaskAdmissionIdentity,
  waitForVmAdmissionCapacity,
} from '../../services/vm-admission-control';
import { scheduleAdmissionWait } from './node-provisioning-admission';
import {
  coreLimitLabel,
  coreQuotaExclusionReason,
  type CoreQuotaRejection,
  coreQuotaRejection,
  nextEligibleAttemptIndex,
} from './node-provisioning-core-quota';
import {
  exhaustionPolicyQueues,
  exhaustionTerminalMessage,
  type ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';
import { discardProviderRejectedNode } from './node-provisioning-rejected-node';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export type ProvisioningAttemptFailureOutcome = 'next-attempt' | 'waiting';

export interface ProvisioningAttemptFailure {
  err: unknown;
  /** Index of the failed attempt in `exhaustionPlan.attempts`. */
  i: number;
  exhaustionPlan: ProvisioningExhaustionPlan;
  diagnosticAttempts: PlacementAttemptDiagnostic[];
  admissionIdentity: VmTaskAdmissionIdentity | null;
  createdNode: { id: string };
  /**
   * Core-quota rejections recorded so far in this attempt chain. A new one is
   * appended here so the step loop skips every offering it rules out.
   */
  coreQuotaRejections: CoreQuotaRejection[];
}

/**
 * Decide what a failed provider allocation means for the attempt chain. Returns
 * `'next-attempt'` to try the next permitted offering and `'waiting'` once the
 * task is parked on the admission queue; throws a permanent error otherwise.
 */
export async function handleProvisioningAttemptFailure(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  failure: ProvisioningAttemptFailure
): Promise<ProvisioningAttemptFailureOutcome> {
  const {
    err,
    i,
    exhaustionPlan,
    diagnosticAttempts,
    admissionIdentity,
    createdNode,
    coreQuotaRejections,
  } = failure;
  const attempt = exhaustionPlan.attempts[i];
  const diagnosticAttempt = diagnosticAttempts[i];
  if (!attempt || !diagnosticAttempt) throw new Error('Missing provisioning attempt diagnostic');

  const providerError = err instanceof ProviderError ? err : null;
  const accountLimit = providerError ? classifyHetznerAccountLimit(providerError) : null;
  const rejection = coreQuotaRejection(accountLimit, attempt);
  if (rejection) {
    coreQuotaRejections.push(rejection);
    recordCoreQuotaExclusions(exhaustionPlan, diagnosticAttempts, i, coreQuotaRejections);
  }
  const nextIndex = nextEligibleAttemptIndex(exhaustionPlan, i, coreQuotaRejections);
  const isCapacityFailure = providerError !== null && isTransientCapacityError(providerError);

  diagnosticAttempt.outcome = isCapacityFailure || accountLimit ? 'capacity-exhausted' : 'failed';
  // Name the provider's own cause. A fixed string here is what made the originating
  // incident's `placement_explanation_json` say only "Provider allocation failed" — true,
  // and useless for working out that Hetzner could not place a cx53 in fsn1.
  const providerDetail = providerError ? `: ${providerError.message}` : '';
  diagnosticAttempt.reason =
    accountLimit && providerError
      ? accountLimitAttemptReason(accountLimit, providerError, rejection, nextIndex !== null)
      : diagnosticAttempt.outcome === 'capacity-exhausted'
        ? `Provider offering has no available capacity${providerDetail}`
        : `Provider allocation failed${providerDetail}`;
  await persistPlacementDiagnostics(state, rc, {
    attempts: diagnosticAttempts,
    selectedNodeId: null,
  });

  // 1. A smaller offering may still fit under the core quota: descend without a
  //    domain cooldown, keeping this task's provisioning lease for the next attempt.
  if (rejection && nextIndex !== null) {
    await discardProviderRejectedNode(state, rc, createdNode.id);
    const nextAttempt = exhaustionPlan.attempts[nextIndex];
    log.info('task_runner_do.node_provisioning.core_quota_descent', {
      taskId: state.taskId,
      policy: exhaustionPlan.policy,
      fromProviderInstanceType: attempt.providerInstanceType,
      fromVcpuCount: rejection.vcpuCount,
      toProviderInstanceType: nextAttempt?.providerInstanceType ?? null,
      toVcpuCount: nextAttempt?.candidate?.providerInstanceVcpuCount ?? null,
      coreClass: rejection.limit.coreClass,
      capacityPoolId: state.config.capacityPoolSelection?.poolId ?? null,
      providerCode: providerError?.providerCode,
    });
    return 'next-attempt';
  }

  // 2. The account is out of this resource for every offering still permitted.
  if (admissionIdentity) {
    const providerCapacity = await recordVmProviderCapacityFailure(rc.env, {
      scope: admissionIdentity,
      error: err,
    });
    if (providerCapacity) {
      await discardProviderRejectedNode(state, rc, createdNode.id);
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'provider_account_capacity'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      await rc.ctx.storage.put('state', state);
      const retryAt = new Date(
        Date.now() + getVmAdmissionConfig(rc.env).providerCooldownMs
      ).toISOString();
      const waitResult = await waitForVmAdmissionCapacity(
        rc.env,
        admissionIdentity,
        'provider_account_capacity',
        retryAt,
        providerCapacity
      );
      if (waitResult.kind === 'expired') {
        await persistPlacementDiagnostics(state, rc, {
          selectedNodeId: null,
          queue: {
            state: 'expired',
            reason: waitResult.reason,
            waitDeadlineAt: waitResult.waitDeadlineAt,
          },
        });
        const detail =
          accountLimit && providerError
            ? ` ${accountLimitMessage(state, accountLimit, providerError)}`
            : '';
        throw Object.assign(new Error(`Timed out waiting for cloud capacity.${detail}`), {
          permanent: true,
        });
      }
      await scheduleAdmissionWait(state, rc, waitResult);
      return 'waiting';
    }
  }

  // No admission queue to park on (admission is off for this domain). Still never
  // surface the bare provider string: say which limit was hit and what to do.
  if (accountLimit && providerError) {
    await releaseVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      'provider_account_capacity'
    );
    state.admissionScopeKey = null;
    state.admissionLeaseToken = null;
    await rc.ctx.storage.put('state', state);
    throw Object.assign(new Error(accountLimitMessage(state, accountLimit, providerError)), {
      permanent: true,
    });
  }

  // 3. Any other non-capacity provider failure fails fast — never descend on
  //    invalid_config / auth_error / rate_limited / unknown.
  if (!isCapacityFailure) {
    await releaseVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      'provisioning_failed'
    );
    state.admissionScopeKey = null;
    state.admissionLeaseToken = null;
    await rc.ctx.storage.put('state', state);
    const message = err instanceof Error ? err.message : 'Node provisioning failed';
    throw Object.assign(new Error(message), { permanent: true });
  }

  // 4. transient_capacity: SKU/region scarcity for one offering. An account quota
  // never reaches here — it either descended or waited above, because retrying
  // same-or-larger offerings against an exhausted account multiplies cost without
  // any chance of succeeding.
  // The failed node row was already deleted inside provisionNode (decision #1).
  state.stepResults.nodeId = null;
  state.stepResults.autoProvisioned = false;
  state.stepResults.provisionedVmSize = null;
  await rc.ctx.storage.put('state', state);

  if (nextIndex !== null) {
    const nextAttempt = exhaustionPlan.attempts[nextIndex];
    if (nextAttempt === undefined) {
      throw Object.assign(new Error('Internal error: provisioning attempt index out of range'), {
        permanent: true,
      });
    }
    log.info('task_runner_do.node_provisioning.exhaustion_fallback', {
      taskId: state.taskId,
      policy: exhaustionPlan.policy,
      fromProviderInstanceType: attempt.providerInstanceType,
      toProviderInstanceType: nextAttempt.providerInstanceType,
      fromLocation: attempt.location,
      toLocation: nextAttempt.location,
      capacityPoolId: state.config.capacityPoolSelection?.poolId ?? null,
      providerCode: providerError?.providerCode,
    });
    return 'next-attempt';
  }

  // Every permitted offering is exhausted. The pool's `queue` policy parks
  // the task on the SHARED admission queue instead of failing it; `fail`
  // and `fallback-chain` terminalize with the list of offerings tried.
  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'transient_capacity_exhausted'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  await rc.ctx.storage.put('state', state);

  const terminalMessage = exhaustionTerminalMessage(
    exhaustionPlan,
    providerError ? providerError.message : null
  );
  if (admissionIdentity && exhaustionPolicyQueues(exhaustionPlan)) {
    const waitResult = await waitForVmAdmissionCapacity(
      rc.env,
      admissionIdentity,
      'provider_transient_capacity'
    );
    if (waitResult.kind === 'expired') {
      await persistPlacementDiagnostics(state, rc, {
        selectedNodeId: null,
        queue: {
          state: 'expired',
          reason: waitResult.reason,
          waitDeadlineAt: waitResult.waitDeadlineAt,
        },
      });
      throw Object.assign(new Error(terminalMessage), { permanent: true });
    }
    await scheduleAdmissionWait(state, rc, waitResult);
    return 'waiting';
  }
  throw Object.assign(new Error(terminalMessage), { permanent: true });
}

/** Give every not-yet-tried attempt the new rejection rules out a reason saying why. */
function recordCoreQuotaExclusions(
  plan: ProvisioningExhaustionPlan,
  diagnosticAttempts: PlacementAttemptDiagnostic[],
  failedIndex: number,
  rejections: readonly CoreQuotaRejection[]
): void {
  for (let index = failedIndex + 1; index < plan.attempts.length; index++) {
    const attempt = plan.attempts[index];
    const diagnostic = diagnosticAttempts[index];
    if (!attempt || !diagnostic || diagnostic.outcome !== 'not-attempted') continue;
    const reason = coreQuotaExclusionReason(attempt, rejections);
    if (reason) diagnostic.reason = reason;
  }
}

function accountLimitAttemptReason(
  limit: HetznerAccountLimit,
  error: ProviderError,
  rejection: CoreQuotaRejection | null,
  descending: boolean
): string {
  if (rejection && descending) {
    return (
      `Provider account ${coreLimitLabel(limit)} reached for this ${rejection.vcpuCount}-vCPU ` +
      `offering; trying offerings that need fewer cores. Provider error: ${error.message}`
    );
  }
  return `Provider account ${accountLimitLabel(limit)} reached. Provider error: ${error.message}`;
}

function accountLimitLabel(limit: HetznerAccountLimit): string {
  if (limit.resource === 'cores') return coreLimitLabel(limit);
  return limit.resource === 'servers' ? 'server limit' : 'resource limit';
}

function accountLimitMessage(
  state: TaskRunnerState,
  limit: HetznerAccountLimit,
  error: ProviderError
): string {
  return describeProviderAccountLimit({
    limit,
    providerMessage: error.message,
    credentialSource: state.config.credentialAttributionSource ?? null,
  });
}
