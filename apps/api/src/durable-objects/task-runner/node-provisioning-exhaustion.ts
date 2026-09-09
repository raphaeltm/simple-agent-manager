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
 * It additionally cannot cross a CREDENTIAL DOMAIN: the VM admission lease and
 * the provider-account cooldown are both keyed by credential domain, so an
 * attempt against a different domain would run outside the lease this task
 * holds and would attribute one account's exhaustion to another.
 */
import type { VMSize } from '@simple-agent-manager/shared';

import type { TaskStartCapacityCandidate } from '../../services/placement-resolver';
import type { TaskRunnerState } from './types';

/** One provisioning attempt: a concrete offering, or a legacy size-only run. */
export interface ProvisioningAttempt {
  /** Null for an unpooled/legacy run that has no provider-native offering. */
  candidate: TaskStartCapacityCandidate | null;
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
  rankedCandidates: readonly TaskStartCapacityCandidate[]
): ProvisioningExhaustionPlan {
  const selection = state.config.capacityPoolSelection ?? null;
  const requestedVmSize = state.config.vmSize;
  const diagnostics: string[] = [];

  if (!selection || rankedCandidates.length === 0) {
    return {
      attempts: [
        {
          candidate: null,
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
  const attempts: ProvisioningAttempt[] = [attemptFor(primary, requestedVmSize)];

  if (policy === 'fallback-chain') {
    for (const candidate of rest) {
      const exclusion = alternativeExclusionReason(primary, candidate);
      if (exclusion) {
        diagnostics.push(`${candidate.id}: ${exclusion}`);
        continue;
      }
      attempts.push(attemptFor(candidate, requestedVmSize));
    }
  }

  return { attempts, policy, diagnostics };
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
  requestedVmSize: VMSize
): ProvisioningAttempt {
  return {
    candidate,
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
  const tried = plan.attempts
    .map((attempt) => attempt.providerInstanceType ?? attempt.vmSize)
    .join(', ');
  return `No capacity for any permitted offering in this compute pool (tried ${tried}).${cause}`;
}
