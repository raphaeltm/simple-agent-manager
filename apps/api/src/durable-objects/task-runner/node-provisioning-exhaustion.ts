/**
 * Capacity-exhaustion planning for TaskRunner node provisioning.
 *
 * Replaces the legacy `vmSizeFallbackChain` descent, which silently downgraded
 * a run to a SMALLER machine than the caller's resolved requirements asked for
 * whenever the size happened to be default-derived. A legacy size is a
 * transport/compatibility label, not an authority over how much hardware the
 * workload needs, so it can no longer decide what to provision next.
 *
 * What replaces it is the pool's own `exhaustionPolicy`, which until now was
 * carried on `TaskStartCapacityPoolSelection` and read by nothing:
 *
 *   fail           one attempt; capacity exhaustion is terminal.
 *   queue          one attempt; capacity exhaustion parks the task on the
 *                  shared admission queue until capacity returns or the wait
 *                  deadline expires.
 *   fallback-chain attempt the pool's other permissible offerings in ranked
 *                  order before giving up.
 *
 * SCOPE OF A FALLBACK ALTERNATIVE
 * -------------------------------
 * Alternatives are drawn only from `selection.candidates` — the offerings of
 * the ONE effective pool the resolver already chose. That list is built by
 * `normalizeCapacityCandidate`, which has already dropped anything that does
 * not match the pool, the resolved provider, an explicitly requested location,
 * the requested execution runtime, the workload role, or the canonical
 * reservation. So iterating it cannot borrow capacity from another pool, cross
 * into a lower-precedence default, relax a hard constraint, or downgrade the
 * run to a different runtime.
 *
 * PROVIDER TIERS
 * --------------
 * Attempts are grouped into tiers, one capacity source (credential domain) per
 * tier. Within a tier the old fence holds: every alternative shares the tier's
 * source, so its lease and cooldown domain. A later tier exists only when the pool
 * has a provider order (`sourceRank`): when the most preferred source cannot
 * allocate, the chain moves to the source ranked next, and the step switches the
 * admission lease to that source's domain before the first attempt there
 * (`node-provisioning-tier.ts`). Without an order the plan has one tier, exactly
 * as before. Within one rank value only the first source is used: same-rank
 * sources do not fall back to each other.
 */
import {
  DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER,
} from '@simple-agent-manager/scheduler-core';
import type { VMSize } from '@simple-agent-manager/shared';

import type { TaskStartCapacityCandidate } from '../../services/placement-resolver';
import type { TaskRunnerState } from './types';

/** One provisioning attempt: a concrete offering, or a legacy size-only run. */
export interface ProvisioningAttempt {
  /** Null for an unpooled/legacy run that has no provider-native offering. */
  candidate: TaskStartCapacityCandidate | null;
  /** 0 for the most preferred source; each later tier is the next-ranked source. */
  tierIndex: number;
  vmSize: VMSize;
  provider: string | null;
  location: string | null;
  providerInstanceType: string | null;
}

export interface ProvisioningExhaustionPlan {
  attempts: ProvisioningAttempt[];
  /**
   * Effective policy for this run. An unpooled/legacy run has no pool to read a
   * policy from and gets `fail`: without a pool there is no set of permissible
   * alternatives to fall back to, and silently substituting a different machine
   * is exactly the behaviour being removed.
   */
  policy: 'queue' | 'fail' | 'fallback-chain';
  /** Sanitized, operator-facing reasons an alternative was excluded. */
  diagnostics: string[];
}

/**
 * True when capacity exhaustion should park the task on the admission queue
 * instead of failing it. Only the pool's own `queue` policy authorizes waiting.
 */
export function exhaustionPolicyQueues(plan: ProvisioningExhaustionPlan): boolean {
  return plan.policy === 'queue';
}

export function buildProvisioningExhaustionPlan(
  state: TaskRunnerState,
  rankedCandidates: readonly TaskStartCapacityCandidate[],
  options: { maxAttemptsPerTier?: number } = {}
): ProvisioningExhaustionPlan {
  const maxAttemptsPerTier =
    options.maxAttemptsPerTier ?? DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER;
  const selection = state.config.capacityPoolSelection ?? null;
  const requestedVmSize = state.config.vmSize;
  const diagnostics: string[] = [];

  if (!selection || rankedCandidates.length === 0) {
    return {
      attempts: [
        {
          candidate: null,
          tierIndex: 0,
          vmSize: requestedVmSize,
          provider: state.config.cloudProvider ?? null,
          location: state.config.vmLocation ?? null,
          providerInstanceType: state.config.providerInstanceType ?? null,
        },
      ],
      policy: 'fail',
      diagnostics,
    };
  }

  const [primary, ...rest] = rankedCandidates;
  if (!primary) {
    // Unreachable: `rankedCandidates.length === 0` returned above. Kept so the
    // narrowing is explicit rather than a non-null assertion.
    return { attempts: [], policy: 'fail', diagnostics };
  }

  const policy = selection.exhaustionPolicy;
  const tierHeads: TaskStartCapacityCandidate[] = [primary];
  const attempts: ProvisioningAttempt[] = [attemptFor(primary, requestedVmSize, 0)];
  const tierAttempts: ProvisioningAttempt[][] = [attempts.slice()];

  for (const candidate of rest) {
    const tierIndex = tierHeads.findIndex(
      (head) => head.capacitySourceId === candidate.capacitySourceId
    );
    const head = tierHeads[tierIndex];
    const tier = tierAttempts[tierIndex];
    if (head && tier) {
      const exclusion = alternativeExclusionReason(head, candidate);
      if (exclusion) {
        diagnostics.push(`${candidate.id}: ${exclusion}`);
        continue;
      }
      // `fail` and `queue` try one offering per tier; `fallback-chain` tries the best-ranked
      // `maxAttemptsPerTier` of them, so a large catalog cannot hold the chain on one source.
      if (policy !== 'fallback-chain') continue;
      if (tier.length >= maxAttemptsPerTier) {
        diagnostics.push(
          `${candidate.id}: beyond the ${maxAttemptsPerTier} offerings tried per provider source`
        );
        continue;
      }
      tier.push(attemptFor(candidate, requestedVmSize, tierIndex));
      continue;
    }
    const exclusion = newTierExclusionReason(primary, tierHeads, candidate);
    if (exclusion) {
      diagnostics.push(`${candidate.id}: ${exclusion}`);
      continue;
    }
    tierHeads.push(candidate);
    tierAttempts.push([attemptFor(candidate, requestedVmSize, tierHeads.length - 1)]);
  }

  return { attempts: tierAttempts.flat(), policy, diagnostics };
}

/** Rank as a sortable key: unranked sources share the last rank. */
function rankKey(candidate: TaskStartCapacityCandidate): number {
  return candidate.sourceRank ?? Number.POSITIVE_INFINITY;
}

/**
 * Why `candidate`, from a source no tier uses yet, may not start a new tier.
 *
 * A new tier is another credential domain, so it is allowed only when the pool asks for it: the
 * pool has a provider order, and the source holds a rank no earlier tier already holds.
 */
function newTierExclusionReason(
  primary: TaskStartCapacityCandidate,
  tierHeads: readonly TaskStartCapacityCandidate[],
  candidate: TaskStartCapacityCandidate
): string | null {
  if (candidate.poolId !== primary.poolId) {
    return 'candidate belongs to a different capacity pool';
  }
  if (primary.sourceRank === null || primary.sourceRank === undefined) {
    return 'candidate resolves to a different capacity source credential, and the pool has no provider order';
  }
  const sameRank = tierHeads.find((head) => rankKey(head) === rankKey(candidate));
  if (sameRank) {
    return `candidate's source has the same provider rank as ${sameRank.capacitySourceId}, which is tried instead`;
  }
  return null;
}

/**
 * Why `candidate` may not be used as an alternative to `primary`.
 *
 * The pool/provider/location/runtime/reservation constraints are already
 * enforced when the candidate list is built, so the only additional fence this
 * layer owns is the credential domain — see the module header.
 */
function alternativeExclusionReason(
  primary: TaskStartCapacityCandidate,
  candidate: TaskStartCapacityCandidate
): string | null {
  // `primary` is the head of the candidate's own tier (same capacity source).
  if (candidate.poolId !== primary.poolId) {
    return 'candidate belongs to a different capacity pool';
  }
  if (candidate.credentialAttributionSource !== primary.credentialAttributionSource) {
    return 'candidate bills a different credential attribution source';
  }
  if (candidate.placementCredentialSource !== primary.placementCredentialSource) {
    return 'candidate uses a different placement credential source';
  }
  if (candidate.capacityPoolProjectId !== primary.capacityPoolProjectId) {
    return 'candidate is scoped to a different project';
  }
  if (candidate.capacitySourceId !== primary.capacitySourceId) {
    // A different source within the same pool means different stored provider
    // credentials, so a different admission lease and cooldown domain.
    return 'candidate resolves to a different capacity source credential';
  }
  return null;
}

function attemptFor(
  candidate: TaskStartCapacityCandidate,
  requestedVmSize: VMSize,
  tierIndex: number
): ProvisioningAttempt {
  return {
    candidate,
    tierIndex,
    // `machineSize` is retained only so legacy consumers keep a readable label.
    // The provisioning payload is driven by `providerInstanceType`.
    vmSize: candidate.machineSize ?? requestedVmSize,
    provider: candidate.provider,
    location: candidate.location,
    providerInstanceType: candidate.providerInstanceType,
  };
}

/**
 * Operator-facing terminal message when every permissible attempt is exhausted.
 *
 * `lastProviderError` is the final attempt's provider message, and it is not decoration. Before
 * 2026-09-09 a Hetzner 412 was classified non-capacity, so the task's failure message WAS the
 * provider's own text ("hetzner API error (412): error during placement") and the failed node row
 * kept the same string in `error_message`. Routing 412 into the capacity path fixes the fallback
 * chain but would otherwise replace that with a template naming no provider, no status and no
 * cause — on the three surfaces a human checks first. Losing the cause is how the originating
 * incident stayed mysterious across three wake attempts; the chain descending is not worth
 * paying for it again.
 *
 * The text is already sanitized and length-bounded by `providerFetch`'s
 * `boundProviderErrorDetail`, and is taken from the parsed error body, so nothing from the
 * request (token, URL) is reachable here.
 */
export function exhaustionTerminalMessage(
  plan: ProvisioningExhaustionPlan,
  lastProviderError?: string | null
): string {
  const cause = lastProviderError ? ` Last provider error: ${lastProviderError}` : '';
  if (plan.attempts.length <= 1) {
    const only = plan.attempts[0];
    const label = only?.providerInstanceType ?? only?.vmSize ?? 'requested';
    return `No capacity available for ${label}.${cause}`;
  }
  const multiProvider = new Set(plan.attempts.map((attempt) => attempt.provider)).size > 1;
  const tried = plan.attempts
    .map((attempt) => {
      const label = attempt.providerInstanceType ?? attempt.vmSize;
      return multiProvider && attempt.provider ? `${attempt.provider} ${label}` : label;
    })
    .join(', ');
  return `No capacity for any permitted offering in this compute pool (tried ${tried}).${cause}`;
}

/** Index of the first attempt in a later tier than `index`, or null. */
export function firstAttemptIndexAfterTier(
  plan: ProvisioningExhaustionPlan,
  index: number
): number | null {
  const tier = plan.attempts[index]?.tierIndex;
  if (tier === undefined) return null;
  const next = plan.attempts.findIndex(
    (attempt, candidateIndex) => candidateIndex > index && attempt.tierIndex > tier
  );
  return next >= 0 ? next : null;
}
