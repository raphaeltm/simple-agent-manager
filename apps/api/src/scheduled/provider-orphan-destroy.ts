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

export async function destroyEligibleCandidates(
  env: Env,
  provider: Provider,
  candidates: Candidate[],
  claims: Map<string, ClaimingNode>,
  scope: OwnershipScope,
  minAgeMs: number,
  destroyLimit: number,
  result: ProviderOrphanResult,
  context: ProviderRequestContext
): Promise<void> {
  for (const candidate of candidates) {
    if (context.signal?.aborted) {
      result.errors++;
      return;
    }
    if (result.destroyed >= destroyLimit) {
      log.info('provider_orphan.destroy_limit_reached', {
        destroyLimit,
        remaining: candidates.length - result.destroyed,
      });
      return;
    }
    const claim = claims.get(candidate.nodeId.toLowerCase());
    if (!claimAllowsDeletion(candidate, claim, result)) continue;
    if (!(await finalOwnershipMatches(provider, candidate, scope, result, context))) continue;
    await destroyCandidate(
      env,
      provider,
      candidate,
      claim?.status,
      scope,
      minAgeMs,
      result,
      context
    );
  }
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
  context: ProviderRequestContext
): Promise<boolean> {
  const current = await readCurrentServer(provider, candidate, result, context);
  if (!current) return false;
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
  return true;
}

async function readCurrentServer(
  provider: Provider,
  candidate: Candidate,
  result: ProviderOrphanResult,
  context: ProviderRequestContext
): Promise<VMInstance | null> {
  try {
    const current = await provider.getVM(candidate.serverId, context);
    if (current) return current;
    result.skippedAmbiguousOwnership++;
    finalOwnershipSkip('provider resource disappeared before exact ownership could be revalidated');
  } catch {
    result.errors++;
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

function finalOwnershipSkip(reason: string): false {
  log.warn('provider_orphan.final_ownership_skipped', {
    reason,
    action: 'preserved without calling the provider delete boundary',
  });
  return false;
}

async function destroyCandidate(
  env: Env,
  provider: Provider,
  candidate: Candidate,
  claimStatus: string | undefined,
  scope: OwnershipScope,
  minAgeMs: number,
  result: ProviderOrphanResult,
  context: ProviderRequestContext
): Promise<void> {
  try {
    log.warn('provider_orphan.destroying', {
      serverId: candidate.serverId,
      nodeId: candidate.nodeId,
      createdAt: candidate.createdAt,
      claimStatus: claimStatus ?? 'no-row',
      environment: scope.environmentLabel,
    });
    await provider.deleteVM(candidate.serverId, context);
    await recordDestroyedOrphan(env, candidate, claimStatus, scope.environmentLabel, minAgeMs);
    result.destroyed++;
  } catch (err) {
    log.error('provider_orphan.destroy_failed', {
      serverId: candidate.serverId,
      nodeId: candidate.nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    result.errors++;
  }
}

async function recordDestroyedOrphan(
  env: Env,
  candidate: Candidate,
  claimStatus: string | undefined,
  environmentLabel: string,
  minAgeMs: number
): Promise<void> {
  await persistError(
    env.OBSERVABILITY_DATABASE,
    {
      source: 'api',
      level: 'warn',
      message: 'Destroyed provider server that no live node row claimed',
      context: {
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
