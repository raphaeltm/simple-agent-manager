/**
 * Entering a provider tier of a TaskRunner provisioning attempt chain.
 *
 * Each tier of `ProvisioningExhaustionPlan` is one capacity source, and so one credential domain:
 * its own VM admission lease, provider cooldown and compute-quota attribution. The step resolves
 * all three for the first tier before its attempt loop, with the same skip rules as here whenever
 * a later tier exists (`node-provisioning-step.ts`). Before the first attempt in a later tier,
 * this module moves them to that tier's source:
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

import { log } from '../../lib/logger';
import {
  releaseVmProvisioningLease,
  tryAcquireVmProvisioningLease,
  type VmTaskAdmissionIdentity,
} from '../../services/vm-admission-control';
import { buildAdmissionIdentity, handleLeaseResult } from './node-provisioning-admission';
import {
  firstAttemptIndexAfterTier,
  type ProvisioningAttempt,
  type ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';
import { enforceComputeQuota } from './node-provisioning-gates';
import {
  acquirePrimaryProvisioningLease,
  providerCooldownSkipReason,
} from './node-provisioning-lease';
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
    return { kind: 'skipped', reason: missingCredentialSkipReason(candidate.provider) };
  }

  const quotaRefusal = await computeQuotaRefusal(state, rc);
  if (quotaRefusal) return { kind: 'skipped', reason: `Skipped: ${quotaRefusal.message}` };

  const lease = await tryAcquireVmProvisioningLease(rc.env, admissionIdentity);
  const cooldown = providerCooldownSkipReason(candidate.provider, lease);
  if (cooldown) return { kind: 'skipped', reason: cooldown };
  if ((await handleLeaseResult(state, rc, lease)) === 'waiting') return { kind: 'waiting' };
  return { kind: 'entered', admissionIdentity };
}

export type PrimaryTierEntry =
  | { kind: 'entered' }
  | { kind: 'step-finished' }
  | { kind: 'skipped'; reason: string; nextIndex: number };

/**
 * The first tier's compute-quota gate and lease, before the attempt loop. With a later tier, the
 * first is skipped for the same reasons a later one is: no credential, spent compute quota, or a
 * provider cooldown. Without one, each fails or waits exactly as before tiers existed.
 */
export async function enterPrimaryProvisioningTier(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  plan: ProvisioningExhaustionPlan,
  admissionIdentity: VmTaskAdmissionIdentity | null
): Promise<PrimaryTierEntry> {
  const nextIndex = firstAttemptIndexAfterTier(plan, 0);
  const skip = (reason: string): PrimaryTierEntry =>
    nextIndex === null ? { kind: 'entered' } : { kind: 'skipped', reason, nextIndex };
  if (nextIndex !== null && !admissionIdentity) {
    return skip(missingCredentialSkipReason(plan.attempts[0]?.provider ?? ''));
  }
  const quotaRefusal = await computeQuotaRefusal(state, rc);
  if (quotaRefusal) {
    if (nextIndex === null) throw quotaRefusal;
    return skip(`Skipped: ${quotaRefusal.message}`);
  }
  if (!admissionIdentity) return { kind: 'entered' };
  const lease = await acquirePrimaryProvisioningLease(state, rc, admissionIdentity, {
    skipOnCooldown: nextIndex !== null,
  });
  if (lease.kind === 'skipped') return skip(lease.reason);
  return lease.kind === 'step-finished' ? lease : { kind: 'entered' };
}

export function logTierSkipped(
  state: TaskRunnerState,
  attempt: ProvisioningAttempt | null,
  tier: number,
  reason: string
): void {
  log.info('task_runner_do.node_provisioning.provider_tier_skipped', {
    taskId: state.taskId,
    provider: attempt?.provider ?? null,
    tier,
    reason,
  });
}

/** Why the current target has no usable credential domain. */
export function missingCredentialSkipReason(provider: string): string {
  return `Skipped: no ${provider} credential could be resolved for this source`;
}

/**
 * The compute-quota gate for the current provisioning target. Returns the gate's permanent
 * refusal (spent platform quota, no credential) instead of throwing it, so a tier can be skipped;
 * anything else, such as a D1 failure, still throws.
 *
 * This checks the `permanent` flag directly rather than using `!isTransientError`: that helper
 * also treats messages containing words such as "invalid", "forbidden" or "not found" as
 * permanent, which would skip a tier for an error that is not a quota refusal.
 */
export async function computeQuotaRefusal(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<Error | null> {
  try {
    await enforceComputeQuota(state, rc);
    return null;
  } catch (error) {
    if (error instanceof Error && (error as Error & { permanent?: unknown }).permanent === true) {
      return error;
    }
    throw error;
  }
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
