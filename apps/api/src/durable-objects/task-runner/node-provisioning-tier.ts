/**
 * Entering the next provider tier of a TaskRunner provisioning attempt chain.
 *
 * Each tier of `ProvisioningExhaustionPlan` is one capacity source, and so one credential domain:
 * its own VM admission lease, provider cooldown and compute-quota attribution. The step resolves
 * all three once for the first tier. Before the first attempt in a later tier, this module moves
 * them to that tier's source:
 *
 *   1. release the lease the previous tier held, so its domain's waiters can proceed;
 *   2. point the provisioning target at the tier's first offering;
 *   3. resolve the tier's admission identity and re-run the compute-quota gate for it;
 *   4. acquire the tier's lease.
 *
 * A tier that cannot be used right now is skipped with a reason, not waited on: its provider is
 * cooling down after an account-capacity error, no credential resolves for it, or its compute
 * quota is spent. A tier whose lease another task holds parks this task exactly as the first tier
 * would (`compatible_node_provisioning`): that task may be creating a node this one can reuse, and
 * the wake restarts the step from the top, where reuse runs before any new VM.
 */
import type { PlacementAttemptDiagnostic } from '@simple-agent-manager/shared';

import {
  releaseVmProvisioningLease,
  tryAcquireVmProvisioningLease,
  type VmTaskAdmissionIdentity,
} from '../../services/vm-admission-control';
import { buildAdmissionIdentity, handleLeaseResult } from './node-provisioning-admission';
import type {
  ProvisioningAttempt,
  ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';
import { enforceComputeQuota } from './node-provisioning-gates';
import { applyCapacityCandidateProvisioningTarget } from './node-provisioning-target';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export type ProvisioningTierEntry =
  | { kind: 'entered'; admissionIdentity: VmTaskAdmissionIdentity | null }
  | { kind: 'skipped'; reason: string }
  | { kind: 'waiting' };

export async function enterProvisioningTier(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  attempt: ProvisioningAttempt
): Promise<ProvisioningTierEntry> {
  const candidate = attempt.candidate;
  if (!candidate) return { kind: 'skipped', reason: 'Skipped: no provider offering' };

  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'provider_tier_fallback'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  applyCapacityCandidateProvisioningTarget(state, candidate);
  await rc.ctx.storage.put('state', state);

  const admissionIdentity = await buildAdmissionIdentity(state, rc);
  if (!admissionIdentity) {
    return {
      kind: 'skipped',
      reason: `Skipped: no ${candidate.provider} credential could be resolved for this source`,
    };
  }

  try {
    await enforceComputeQuota(state, rc);
  } catch (error) {
    if (!isPermanentError(error)) throw error;
    return { kind: 'skipped', reason: `Skipped: ${error.message}` };
  }

  const lease = await tryAcquireVmProvisioningLease(rc.env, admissionIdentity);
  if (lease.kind === 'waiting' && lease.reason === 'provider_account_capacity') {
    return {
      kind: 'skipped',
      reason: `Skipped: the ${candidate.provider} account is cooling down after a capacity error until ${lease.nextRetryAt}`,
    };
  }
  if ((await handleLeaseResult(state, rc, lease)) === 'waiting') return { kind: 'waiting' };
  return { kind: 'entered', admissionIdentity };
}

function isPermanentError(error: unknown): error is Error {
  return error instanceof Error && (error as Error & { permanent?: unknown }).permanent === true;
}

/** Give every attempt of a skipped tier the reason, leaving it `not-attempted`. */
export function markTierSkipped(
  plan: ProvisioningExhaustionPlan,
  diagnosticAttempts: PlacementAttemptDiagnostic[],
  tierIndex: number,
  reason: string
): void {
  plan.attempts.forEach((attempt, index) => {
    const diagnostic = diagnosticAttempts[index];
    if (attempt.tierIndex === tierIndex && diagnostic?.outcome === 'not-attempted') {
      diagnostic.reason = reason;
    }
  });
}
