/**
 * Provider-allocation failure handling for one TaskRunner `node_provisioning`
 * attempt.
 *
 * Split out of `node-provisioning-step.ts` (rule 18). Pure code motion; the only
 * adaptation is control flow: where the inline block used `continue` it now
 * returns `'next-attempt'`, and where it returned from the step after parking the
 * task on the admission queue it now returns `'waiting'`.
 */
import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import type { PlacementAttemptDiagnostic } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  getVmAdmissionConfig,
  recordVmProviderCapacityFailure,
  releaseVmProvisioningLease,
  type VmTaskAdmissionIdentity,
  waitForVmAdmissionCapacity,
} from '../../services/vm-admission-control';
import { scheduleAdmissionWait } from './node-provisioning-admission';
import {
  exhaustionPolicyQueues,
  exhaustionTerminalMessage,
  type ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';
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
  const { err, i, exhaustionPlan, diagnosticAttempts, admissionIdentity, createdNode } = failure;
  const attempt = exhaustionPlan.attempts[i];
  const diagnosticAttempt = diagnosticAttempts[i];
  if (!attempt || !diagnosticAttempt) throw new Error('Missing provisioning attempt diagnostic');
  const isLastAttempt = i === exhaustionPlan.attempts.length - 1;
  diagnosticAttempt.outcome =
    err instanceof ProviderError && isTransientCapacityError(err) ? 'capacity-exhausted' : 'failed';
  // Name the provider's own cause. A fixed string here is what made the originating
  // incident's `placement_explanation_json` say only "Provider allocation failed" — true,
  // and useless for working out that Hetzner could not place a cx53 in fsn1.
  const providerDetail = err instanceof ProviderError ? `: ${err.message}` : '';
  diagnosticAttempt.reason =
    diagnosticAttempt.outcome === 'capacity-exhausted'
      ? `Provider offering has no available capacity${providerDetail}`
      : `Provider allocation failed${providerDetail}`;
  await persistPlacementDiagnostics(state, rc, {
    attempts: diagnosticAttempts,
    selectedNodeId: null,
  });
  if (admissionIdentity) {
    const providerCapacity = await recordVmProviderCapacityFailure(rc.env, {
      scope: admissionIdentity,
      error: err,
    });
    if (providerCapacity) {
      diagnosticAttempt.outcome = 'capacity-exhausted';
      diagnosticAttempt.reason = 'Provider account capacity is exhausted';
      await persistPlacementDiagnostics(state, rc, {
        attempts: diagnosticAttempts,
        selectedNodeId: null,
      });
      await rc.env.DATABASE.prepare(
        `DELETE FROM nodes WHERE id = ? AND provider_instance_id IS NULL`
      )
        .bind(createdNode.id)
        .run();
      await rc.env.DATABASE.prepare(
        `UPDATE tasks SET auto_provisioned_node_id = NULL, updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), state.taskId)
        .run();
      state.stepResults.nodeId = null;
      state.stepResults.autoProvisioned = false;
      state.stepResults.provisionedVmSize = null;
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
        throw Object.assign(new Error('Timed out waiting for provider account capacity'), {
          permanent: true,
        });
      }
      await scheduleAdmissionWait(state, rc, waitResult);
      return 'waiting';
    }
  }
  const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);

  // Any non-capacity provider failure fails fast — never descend on
  // invalid_config / quota_exceeded / auth_error / rate_limited / unknown.
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

  // transient_capacity: this is SKU/region scarcity for one offering, not
  // an account-wide limit (that branch returned above, and it deliberately
  // does NOT try alternatives — retrying other SKUs against an exhausted
  // account multiplies cost without any chance of succeeding).
  // The failed node row was already deleted inside provisionNode (decision #1).
  state.stepResults.nodeId = null;
  state.stepResults.autoProvisioned = false;
  state.stepResults.provisionedVmSize = null;
  await rc.ctx.storage.put('state', state);

  if (!isLastAttempt) {
    const nextAttempt = exhaustionPlan.attempts[i + 1];
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
      providerCode: err instanceof ProviderError ? err.providerCode : undefined,
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
    err instanceof ProviderError ? err.message : null
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
