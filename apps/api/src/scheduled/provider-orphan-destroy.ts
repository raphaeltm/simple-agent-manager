/**
 * The destroy half of provider orphan reconciliation: for candidates the core selected, check the
 * D1 claim, re-read the provider resource for exact ownership, then delete it and record the
 * deletion. Split from provider-orphan-reconciliation-core.ts (file size, rule 18).
 */
import {
  hasAmbiguousLabel,
  type Provider,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  SAM_ENVIRONMENT_LABEL_KEY,
  SAM_INSTALLATION_LABEL_KEY,
  SAM_MANAGED_LABEL_KEY,
  SAM_MANAGED_LABEL_VALUE,
  SAM_NODE_LABEL_KEY,
} from '../services/node-provider-labels';
import { persistError } from '../services/observability';
import type { ClaimingNode } from './provider-orphan-inventory';
import type {
  Candidate,
  OwnershipScope,
  ProviderOrphanResult,
} from './provider-orphan-reconciliation-core';

const TERMINAL_NODE_STATUSES: ReadonlySet<string> = new Set(['deleted', 'destroyed']);

/**
 * Time bounds of the destroy loop. `requestTimeoutMs` bounds ONE provider call (the ownership
 * re-read, the delete); each call gets its own signal, so a slow provider's lookups cannot use
 * up the time of the delete that follows them. `deadline` is the sweep budget: no candidate is
 * started after it, and the rest wait for the next eligible pass.
 */
export interface DestroyBounds {
  requestTimeoutMs: number;
  deadline: number;
}

/**
 * Where a failure attributable to the provider account goes: `errors` for the installation's
 * platform account (the sweep itself is failing), `accountErrors` for a user/project account
 * (that account's credential or cloud). Shared-infrastructure failures (D1 claim lookup,
 * credential listing) always count in `errors`, whichever account they happen in.
 */
export type ProviderErrorKey = 'errors' | 'accountErrors';

/** Deletions this pass started: completed synchronously, or requested and still in flight. */
export function deletionsStarted(result: ProviderOrphanResult): number {
  return result.destroyed + result.deletionRequested;
}

export async function destroyEligibleCandidates(
  env: Env,
  provider: Provider,
  candidates: Candidate[],
  claims: Map<string, ClaimingNode>,
  scope: OwnershipScope,
  minAgeMs: number,
  destroyLimit: number,
  result: ProviderOrphanResult,
  bounds: DestroyBounds,
  providerErrors: ProviderErrorKey
): Promise<void> {
  for (const [index, candidate] of candidates.entries()) {
    if (deletionsStarted(result) >= destroyLimit) {
      log.info('provider_orphan.destroy_limit_reached', {
        destroyLimit,
        remaining: candidates.length - index,
      });
      return;
    }
    if (Date.now() >= bounds.deadline) {
      log.info('provider_orphan.sweep_budget_reached', {
        remaining: candidates.length - index,
        action: 'left for the next eligible pass; nothing was sent for them',
      });
      return;
    }
    const claim = claims.get(candidate.nodeId.toLowerCase());
    if (!claimAllowsDeletion(candidate, claim, result)) continue;
    const proven = await finalOwnershipMatches(
      provider,
      candidate,
      scope,
      result,
      requestContext(bounds),
      providerErrors
    );
    if (!proven) continue;
    await destroyCandidate(
      env,
      provider,
      candidate,
      proven,
      claim?.status,
      scope,
      minAgeMs,
      result,
      requestContext(bounds),
      providerErrors
    );
  }
}

function requestContext(bounds: DestroyBounds): ProviderRequestContext {
  return { signal: AbortSignal.timeout(bounds.requestTimeoutMs) };
}

function claimAllowsDeletion(
  candidate: Candidate,
  claim: ClaimingNode | undefined,
  result: ProviderOrphanResult
): boolean {
  if (claim && !TERMINAL_NODE_STATUSES.has(claim.status)) {
    result.skippedClaimed++;
    return false;
  }
  if (claim && claim.providerInstanceId !== candidate.serverId) {
    result.skippedAmbiguousClaim++;
    log.warn('provider_orphan.ambiguous_claim_skipped', {
      reason: 'terminal D1 claim points at a different provider instance',
      nodeId: candidate.nodeId,
      action: 'preserved without calling the provider delete boundary',
    });
    return false;
  }
  return true;
}

async function finalOwnershipMatches(
  provider: Provider,
  candidate: Candidate,
  scope: OwnershipScope,
  result: ProviderOrphanResult,
  context: ProviderRequestContext,
  providerErrors: ProviderErrorKey
): Promise<VMInstance | null> {
  const current = await readCurrentServer(provider, candidate, result, context, providerErrors);
  if (!current) return null;
  const labels = current.labels ?? {};
  if (hasAmbiguousOwnershipLabels(labels)) {
    result.skippedAmbiguousOwnership++;
    return finalOwnershipSkip('provider ownership metadata became ambiguous before deletion');
  }
  if (labels[SAM_MANAGED_LABEL_KEY] !== SAM_MANAGED_LABEL_VALUE) {
    result.skippedForeignManaged++;
    return finalOwnershipSkip('managed scope changed before deletion');
  }
  if (labels[SAM_ENVIRONMENT_LABEL_KEY] !== scope.environmentLabel) {
    result.skippedForeignEnv++;
    return finalOwnershipSkip('environment scope changed before deletion');
  }
  if (labels[SAM_INSTALLATION_LABEL_KEY] !== scope.installationId) {
    result.skippedForeignInstallation++;
    return finalOwnershipSkip('installation ownership changed before deletion');
  }
  if (!sameResourceIdentity(current, candidate)) {
    result.skippedAmbiguousOwnership++;
    return finalOwnershipSkip('provider resource identity changed before deletion');
  }
  return current;
}

async function readCurrentServer(
  provider: Provider,
  candidate: Candidate,
  result: ProviderOrphanResult,
  context: ProviderRequestContext,
  providerErrors: ProviderErrorKey
): Promise<VMInstance | null> {
  try {
    const current = await provider.getVM(candidate.serverId, context);
    if (current) return current;
    result.skippedAmbiguousOwnership++;
    finalOwnershipSkip('provider resource disappeared before exact ownership could be revalidated');
  } catch {
    result[providerErrors]++;
    log.warn('provider_orphan.final_ownership_unavailable', {
      reason: 'provider resource could not be re-read for exact ownership proof',
      action: 'preserved for retry without calling the provider delete boundary',
    });
  }
  return null;
}

function sameResourceIdentity(current: VMInstance, candidate: Candidate): boolean {
  return (
    current.id === candidate.serverId &&
    current.labels?.[SAM_NODE_LABEL_KEY] === candidate.nodeId &&
    current.createdAt === candidate.createdAt
  );
}

export function hasAmbiguousOwnershipLabels(labels: Record<string, string>): boolean {
  return [
    SAM_MANAGED_LABEL_KEY,
    SAM_ENVIRONMENT_LABEL_KEY,
    SAM_INSTALLATION_LABEL_KEY,
    SAM_NODE_LABEL_KEY,
  ].some((key) => hasAmbiguousLabel(labels, key));
}

function finalOwnershipSkip(reason: string): null {
  log.warn('provider_orphan.final_ownership_skipped', {
    reason,
    action: 'preserved without calling the provider delete boundary',
  });
  return null;
}

/**
 * Delete one proven orphan.
 *
 * A provider with two-phase deletion (GCP today) gets a send-and-return request bound to the
 * exact instance the ownership re-read just proved (`expectedInstance`: same numeric id, same
 * zone), so the delete can never land on anything the proof did not cover. It is counted as
 * `deletionRequested`, never as `destroyed`: the provider has accepted it but not finished it.
 * The next eligible pass is idempotent either way: a VM still being deleted (or whose delete
 * failed) is selected and requested again; one already gone is not listed at all.
 * `deleteVM` on GCP polls the operation to completion, which cannot fit a background request
 * budget. Every other provider keeps `deleteVM`, which returns once the delete is done.
 */
async function destroyCandidate(
  env: Env,
  provider: Provider,
  candidate: Candidate,
  proven: VMInstance,
  claimStatus: string | undefined,
  scope: OwnershipScope,
  minAgeMs: number,
  result: ProviderOrphanResult,
  context: ProviderRequestContext,
  providerErrors: ProviderErrorKey
): Promise<void> {
  // The two-phase binding needs both halves. A re-read without a location cannot bind the
  // zone, so refuse rather than fall back to an id-only binding.
  if (provider.requestVMDeletion && !proven.location) {
    result.skippedAmbiguousOwnership++;
    finalOwnershipSkip('provider re-read reported no location to bind the deletion to');
    return;
  }
  try {
    log.warn('provider_orphan.destroying', {
      serverId: candidate.serverId,
      nodeId: candidate.nodeId,
      createdAt: candidate.createdAt,
      claimStatus: claimStatus ?? 'no-row',
      environment: scope.environmentLabel,
    });
    if (provider.requestVMDeletion) {
      const request = await provider.requestVMDeletion(candidate.serverId, context, {
        expectedInstance: {
          id: proven.id,
          location: proven.location,
          // The ownership scope the re-read proved, re-checked on the provider's last read
          // before the DELETE (rule 56).
          labels: {
            [SAM_MANAGED_LABEL_KEY]: SAM_MANAGED_LABEL_VALUE,
            [SAM_ENVIRONMENT_LABEL_KEY]: scope.environmentLabel,
            [SAM_INSTALLATION_LABEL_KEY]: scope.installationId,
            [SAM_NODE_LABEL_KEY]: candidate.nodeId,
          },
        },
      });
      if (request.state === 'absent') {
        log.info('provider_orphan.already_absent', {
          serverId: candidate.serverId,
          nodeId: candidate.nodeId,
          action: 'nothing sent; the provider no longer has this instance',
        });
        return;
      }
      log.warn('provider_orphan.deletion_requested', {
        serverId: candidate.serverId,
        nodeId: candidate.nodeId,
        location: proven.location ?? null,
      });
      await recordDestroyedOrphan(
        env,
        candidate,
        claimStatus,
        scope.environmentLabel,
        minAgeMs,
        'requested'
      );
      result.deletionRequested++;
      return;
    }
    await provider.deleteVM(candidate.serverId, context);
    await recordDestroyedOrphan(
      env,
      candidate,
      claimStatus,
      scope.environmentLabel,
      minAgeMs,
      'completed'
    );
    result.destroyed++;
  } catch (err) {
    log.error('provider_orphan.destroy_failed', {
      serverId: candidate.serverId,
      nodeId: candidate.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    result[providerErrors]++;
  }
}

async function recordDestroyedOrphan(
  env: Env,
  candidate: Candidate,
  claimStatus: string | undefined,
  environmentLabel: string,
  minAgeMs: number,
  deletion: 'completed' | 'requested'
): Promise<void> {
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'warn',
      message:
        deletion === 'completed'
          ? 'Destroyed provider server that no live node row claimed'
          : 'Requested deletion of provider server that no live node row claimed',
      context: {
        deletion,
        recoveryType: 'provider_orphan_reconciliation',
        nodeId: candidate.nodeId,
        providerInstanceId: candidate.serverId,
        serverCreatedAt: candidate.createdAt,
        claimStatus: claimStatus ?? 'no-row',
        environment: environmentLabel,
        minAgeMs,
      },
      nodeId: candidate.nodeId,
    },
    env
  );
}
