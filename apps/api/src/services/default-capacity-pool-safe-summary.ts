/**
 * The pool summary that is safe to show to anyone who uses the pool: its state, strategy and the
 * machine types it can place, with no credential or source detail. Split out of
 * default-capacity-pool-summaries.ts, which builds the full editor summaries.
 */
import type {
  DefaultCapacityPoolEffectiveState,
  SafeEffectiveCapacityPoolReason,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { isCapacitySourceExcluded, isValidProvider } from '@simple-agent-manager/shared';

import {
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from '../scheduler-core';
import { ACTIVE_STATUS, SOURCE_KIND_CLOUD_PROVIDER } from './default-capacity-pool-storage';
import type { CapacityPoolSummary } from './default-capacity-pool-types';

export function toSafeEffectiveCapacityPoolSummary(
  summary: CapacityPoolSummary | null
): SafeEffectiveCapacityPoolSummary {
  if (!summary) {
    return {
      scope: null,
      state: 'unconfigured',
      strategy: null,
      deploymentStrategy: null,
      exhaustionPolicy: null,
      availableCandidateCount: 0,
      nativeOfferings: [],
      reason: 'no-capacity-pool-configured',
    };
  }

  const state = summary.effectiveState ?? 'configured-ready';
  const activeSources = new Set(
    summary.sources
      .filter(
        (source) =>
          source.status === ACTIVE_STATUS &&
          source.sourceKind === SOURCE_KIND_CLOUD_PROVIDER &&
          !isCapacitySourceExcluded(summary.pool, source.id)
      )
      .map((source) => source.id)
  );
  const nativeOfferings: NonNullable<SafeEffectiveCapacityPoolSummary['nativeOfferings']> = [];
  const seen = new Set<string>();
  if (state === 'configured-ready') {
    for (const candidate of summary.candidates) {
      if (
        candidate.status !== ACTIVE_STATUS ||
        !activeSources.has(candidate.capacitySourceId) ||
        candidate.workloadRole !== PRIMARY_CAPACITY_WORKLOAD_ROLE ||
        candidate.runtime !== 'vm' ||
        candidate.catalogAvailability !== 'available' ||
        !candidate.providerInstanceCatalogSource ||
        !candidate.provider ||
        !isValidProvider(candidate.provider) ||
        !candidate.location ||
        !candidate.providerInstanceType
      )
        continue;
      const key = JSON.stringify([
        candidate.provider,
        candidate.location,
        candidate.providerInstanceType,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      nativeOfferings.push({
        provider: candidate.provider,
        location: candidate.location,
        providerInstanceType: candidate.providerInstanceType,
        displayName: candidate.providerInstanceDisplayName ?? candidate.providerInstanceType,
        vcpu: candidate.providerInstanceVcpuCount,
        memoryMb: candidate.providerInstanceMemoryMb,
        diskGb: candidate.providerInstanceDiskGb,
        price: candidate.providerInstancePriceDisplay,
      });
    }
  }
  return {
    scope: summary.pool.scope,
    state,
    strategy: summary.pool.strategy,
    deploymentStrategy: summary.pool.deploymentStrategy,
    exhaustionPolicy: summary.pool.exhaustionPolicy,
    availableCandidateCount: summary.availableCandidateCount ?? 0,
    nativeOfferings,
    reason: safeEffectiveReasonForState(state),
  };
}

function safeEffectiveReasonForState(
  state: DefaultCapacityPoolEffectiveState
): SafeEffectiveCapacityPoolReason | undefined {
  switch (state) {
    case 'configured-ready':
      return undefined;
    case 'unconfigured':
      return 'no-capacity-pool-configured';
    case 'configured-empty':
      return 'configured-default-pool-has-no-active-candidates';
    case 'source-disabled':
      return 'configured-default-pool-sources-disabled';
    case 'catalog-unavailable':
      return 'configured-default-pool-catalog-last-known-unavailable';
    case 'migration-pending':
      return 'configured-default-pool-migration-pending';
  }
}
