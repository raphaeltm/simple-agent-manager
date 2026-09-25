/**
 * Core-quota descent for the TaskRunner `node_provisioning` attempt chain.
 *
 * A provider account quota on vCPU cores (Hetzner `403 resource_limit_exceeded`, "shared core
 * limit exceeded") rejects an offering because of how many cores it needs, not because of where
 * it is or what type it is. Every remaining offering in the same core class that needs AT LEAST as
 * many cores would be rejected the same way, so it is skipped. One that needs fewer may still
 * fit, so the chain descends to it. Only when no such offering remains is the account out of
 * capacity for this request, and the task waits on `provider_account_capacity`.
 *
 * On 2026-09-25 three wakes of one conversation each tried cx53 (16 cores), hit this quota and
 * failed permanently. cx43, cx33 and cx23 were in the chain and were never tried, although about
 * 28 shared cores were in use.
 *
 * Offerings stay in the pool's own ranked order — this only removes the ones the quota already
 * ruled out. The resource requirements the run resolved are untouched: every attempt in the
 * chain satisfies them, which is what "pin resources, never the machine type" asks.
 */
import { type HetznerAccountLimit, hetznerCoreLimitCovers } from '@simple-agent-manager/providers';

import type {
  ProvisioningAttempt,
  ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';

/** One offering the core quota rejected, and the cores it needed. */
export interface CoreQuotaRejection {
  limit: HetznerAccountLimit;
  vcpuCount: number;
}

/**
 * The rejection a core quota records for `attempt`, or null when the limit is not a core quota
 * or the attempt's vCPU count is unknown. A legacy size-only run has no concrete offering to
 * compare against, and nothing to descend to either.
 */
export function coreQuotaRejection(
  limit: HetznerAccountLimit | null,
  attempt: ProvisioningAttempt
): CoreQuotaRejection | null {
  const vcpuCount = attempt.candidate?.providerInstanceVcpuCount ?? null;
  if (limit?.resource !== 'cores' || vcpuCount === null) return null;
  return { limit, vcpuCount };
}

/**
 * Why a recorded core rejection rules `attempt` out, or null when the attempt may still fit.
 * An attempt with an unknown vCPU count or type is never ruled out: trying it costs one create
 * call, while skipping it wrongly could leave the task waiting when capacity existed.
 */
export function coreQuotaExclusionReason(
  attempt: ProvisioningAttempt,
  rejections: readonly CoreQuotaRejection[]
): string | null {
  const vcpuCount = attempt.candidate?.providerInstanceVcpuCount ?? null;
  const serverType = attempt.providerInstanceType;
  if (vcpuCount === null || !serverType) return null;
  const rejection = rejections.find(
    (entry) => vcpuCount >= entry.vcpuCount && hetznerCoreLimitCovers(entry.limit, serverType)
  );
  if (!rejection) return null;
  return (
    `Skipped: needs ${vcpuCount} vCPU, and the account's ${coreLimitLabel(rejection.limit)} ` +
    `already rejected a ${rejection.vcpuCount}-vCPU offering`
  );
}

/** Index of the next attempt after `afterIndex` that no recorded core rejection rules out. */
export function nextEligibleAttemptIndex(
  plan: ProvisioningExhaustionPlan,
  afterIndex: number,
  rejections: readonly CoreQuotaRejection[]
): number | null {
  for (let index = afterIndex + 1; index < plan.attempts.length; index++) {
    const attempt = plan.attempts[index];
    if (attempt && coreQuotaExclusionReason(attempt, rejections) === null) return index;
  }
  return null;
}

/** "shared vCPU core limit", "dedicated vCPU core limit", or "vCPU core limit". */
export function coreLimitLabel(limit: HetznerAccountLimit): string {
  return `${limit.coreClass ? `${limit.coreClass} ` : ''}vCPU core limit`;
}
