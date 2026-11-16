/**
 * Quota descent for the TaskRunner `node_provisioning` attempt chain.
 *
 * A provider quota rejects an offering because of how much of one resource it needs, in one
 * scope, not because the provider has nothing left. Every remaining offering the same quota would
 * reject the same way is skipped; the rest of the chain is still tried, in the pool's own ranked
 * order. Only when no such offering remains in the tier does the failure handler move on.
 *
 *   Hetzner core quota  Account-wide vCPU cores of one class (`403 resource_limit_exceeded`,
 *                       "shared core limit exceeded"). Rules out offerings of that core class
 *                       needing at least as many cores. On 2026-09-25 three wakes each tried cx53
 *                       (16 cores), hit it and failed; cx43, cx33 and cx23 were never tried.
 *   GCP quota bucket    One metric in one region (`Quota 'T2D_CPUS' exceeded. Limit: 24.0 in
 *                       region europe-west1.`). Rules out what that bucket counts in that region
 *                       (`gcpQuotaBucketCovers`); other regions, other families and smaller types
 *                       remain. On 2026-11-12/13, 14 tasks went to Hetzner after this error while
 *                       europe-west4 T2D and all E2 quota were unused.
 *
 * A quota belongs to one provider account, so a rejection never rules out an offering from
 * another capacity source. The resource requirements the run resolved are untouched: every
 * attempt in the chain satisfies them ("pin resources, never the machine type").
 */
import {
  classifyGcpQuotaBucket,
  classifyHetznerAccountLimit,
  describeGcpQuotaBucket,
  type GcpQuotaBucket,
  gcpQuotaBucketCovers,
  type GcpQuotaOffering,
  type HetznerAccountLimit,
  hetznerCoreLimitCovers,
  type ProviderError,
} from '@simple-agent-manager/providers';

import type {
  ProvisioningAttempt,
  ProvisioningExhaustionPlan,
} from './node-provisioning-exhaustion';

/** One offering a quota rejected, and what it needed. */
export type QuotaRejection =
  | {
      kind: 'hetzner-cores';
      limit: HetznerAccountLimit;
      vcpuCount: number;
      /** The capacity source whose account hit the quota. */
      capacitySourceId: string | null;
    }
  | {
      kind: 'gcp-bucket';
      bucket: GcpQuotaBucket;
      /** The refused offering, for the bucket's size comparison. */
      refused: GcpQuotaOffering;
      capacitySourceId: string | null;
    };

/**
 * The rejection a quota error records for `attempt`, or null when the error is not a quota the
 * chain can descend under, or the attempt has no concrete offering to compare against. A legacy
 * size-only run has nothing to descend to.
 */
export function quotaRejectionFor(
  error: ProviderError | null,
  attempt: ProvisioningAttempt
): QuotaRejection | null {
  if (!error || !attempt.candidate) return null;
  const capacitySourceId = attempt.candidate.capacitySourceId ?? null;
  const limit = classifyHetznerAccountLimit(error);
  if (limit) {
    const vcpuCount = attempt.candidate.providerInstanceVcpuCount ?? null;
    if (limit.resource !== 'cores' || vcpuCount === null) return null;
    return { kind: 'hetzner-cores', limit, vcpuCount, capacitySourceId };
  }
  const bucket = classifyGcpQuotaBucket(error);
  const refused = gcpQuotaOffering(attempt);
  if (!bucket || !refused) return null;
  return { kind: 'gcp-bucket', bucket, refused, capacitySourceId };
}

/**
 * Why a recorded rejection rules `attempt` out, or null when the attempt may still fit. An attempt
 * whose size or type is unknown is never ruled out: trying it costs one create call, while
 * skipping it wrongly could send the task elsewhere when capacity existed.
 */
export function quotaExclusionReason(
  attempt: ProvisioningAttempt,
  rejections: readonly QuotaRejection[]
): string | null {
  const capacitySourceId = attempt.candidate?.capacitySourceId ?? null;
  for (const rejection of rejections) {
    if (rejection.capacitySourceId !== capacitySourceId) continue;
    const reason =
      rejection.kind === 'hetzner-cores'
        ? hetznerCoreExclusionReason(attempt, rejection)
        : gcpBucketExclusionReason(attempt, rejection);
    if (reason) return reason;
  }
  return null;
}

/** Index of the next attempt after `afterIndex` that no recorded rejection rules out. */
export function nextEligibleAttemptIndex(
  plan: ProvisioningExhaustionPlan,
  afterIndex: number,
  rejections: readonly QuotaRejection[]
): number | null {
  for (let index = afterIndex + 1; index < plan.attempts.length; index++) {
    const attempt = plan.attempts[index];
    if (attempt && quotaExclusionReason(attempt, rejections) === null) return index;
  }
  return null;
}

/** "shared vCPU core limit", "dedicated vCPU core limit", or "vCPU core limit". */
export function coreLimitLabel(limit: HetznerAccountLimit): string {
  return `${limit.coreClass ? `${limit.coreClass} ` : ''}vCPU core limit`;
}

/** The refused attempt's reason, naming the quota and saying what the chain tries next. */
export function quotaDescentReason(rejection: QuotaRejection, providerMessage: string): string {
  if (rejection.kind === 'hetzner-cores') {
    return (
      `Provider account ${coreLimitLabel(rejection.limit)} reached for this ` +
      `${rejection.vcpuCount}-vCPU offering; trying offerings that need fewer cores. ` +
      `Provider error: ${providerMessage}`
    );
  }
  return (
    `${describeGcpQuotaBucket(rejection.bucket)} is used up for this offering; trying ` +
    `${gcpBucketRemainder(rejection.bucket)} before another provider. Provider error: ${providerMessage}`
  );
}

/**
 * The refused attempt's reason when the quota leaves nothing else to try in this tier. Names the
 * quota rather than "no available capacity", so a regional quota and a zone stockout stay apart in
 * the placement record (`.claude/rules/74`).
 */
export function quotaExhaustedReason(rejection: QuotaRejection, providerMessage: string): string {
  const quota =
    rejection.kind === 'hetzner-cores'
      ? `Provider account ${coreLimitLabel(rejection.limit)}`
      : describeGcpQuotaBucket(rejection.bucket);
  return `${quota} is used up, and no other offering from this source remains. Provider error: ${providerMessage}`;
}

function hetznerCoreExclusionReason(
  attempt: ProvisioningAttempt,
  rejection: Extract<QuotaRejection, { kind: 'hetzner-cores' }>
): string | null {
  const vcpuCount = attempt.candidate?.providerInstanceVcpuCount ?? null;
  const serverType = attempt.providerInstanceType;
  if (vcpuCount === null || !serverType) return null;
  if (vcpuCount < rejection.vcpuCount) return null;
  if (!hetznerCoreLimitCovers(rejection.limit, serverType)) return null;
  return (
    `Skipped: needs ${vcpuCount} vCPU, and the account's ${coreLimitLabel(rejection.limit)} ` +
    `already rejected a ${rejection.vcpuCount}-vCPU offering`
  );
}

function gcpBucketExclusionReason(
  attempt: ProvisioningAttempt,
  rejection: Extract<QuotaRejection, { kind: 'gcp-bucket' }>
): string | null {
  const offering = gcpQuotaOffering(attempt);
  if (!offering || !gcpQuotaBucketCovers(rejection.bucket, rejection.refused, offering)) {
    return null;
  }
  const { bucket, refused } = rejection;
  const size =
    bucket.resource === 'cpus'
      ? `needs ${offering.vcpuCount} vCPU, and ${describeGcpQuotaBucket(bucket)} already rejected a ${refused.vcpuCount}-vCPU offering`
      : bucket.resource === 'ssd'
        ? `needs a ${offering.diskGb} GB disk, and ${describeGcpQuotaBucket(bucket)} already rejected a ${refused.diskGb} GB disk`
        : `${describeGcpQuotaBucket(bucket)} already rejected an offering in this region`;
  return `Skipped: ${size}`;
}

function gcpBucketRemainder(bucket: GcpQuotaBucket): string {
  switch (bucket.resource) {
    case 'cpus':
      return 'smaller types of this family, other families and other regions';
    case 'ssd':
      return 'offerings with smaller disks and other regions';
    case 'other':
      return 'other regions';
  }
}

function gcpQuotaOffering(attempt: ProvisioningAttempt): GcpQuotaOffering | null {
  if (attempt.provider !== 'gcp' || !attempt.providerInstanceType || !attempt.location) return null;
  return {
    machineType: attempt.providerInstanceType,
    zone: attempt.location,
    vcpuCount: attempt.candidate?.providerInstanceVcpuCount ?? null,
    diskGb: attempt.candidate?.providerInstanceDiskGb ?? null,
  };
}
