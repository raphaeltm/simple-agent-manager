import type {
  CapacityPoolPlacementSettings,
  CapacityPoolStrategy,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { resolveApproximateBillingMonthHours } from '@simple-agent-manager/shared';

import { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-placement-settings';
import type { TaskStartCapacityCandidate } from './placement-resolver-types';
import {
  comparePlacementLocationsByStrategy,
  type PlacementLocationInventory,
} from './placement-strategy';

const MAX_SCORE_WEIGHT = 1_000_000_000;

export interface RankCapacityCandidatesInput {
  strategy: CapacityPoolStrategy;
  reservation: ResolvedResourceReservation;
  settings?: CapacityPoolPlacementSettings;
  /**
   * Live host distribution for the caller. Only `pack` and `spread` consult it,
   * and only at provisioning time — resolve-time ordering has no host inventory
   * and must stay byte-identical, so an absent inventory is a strict no-op.
   */
  locationInventory?: PlacementLocationInventory;
}

/**
 * Re-rank an already-resolved candidate list at provisioning time.
 *
 * `pack` and `spread` are meaningless for a brand-new offering considered in
 * isolation: neither utilization nor co-tenancy exists yet. They become
 * observable only against the caller's live host distribution, which the
 * resolver does not have. This applies that distribution as the leading key for
 * those two strategies and otherwise preserves the resolver's exact ordering.
 *
 * Returns a new array; the input is not mutated.
 */
export function rankCapacityCandidatesForRuntime(
  candidates: readonly TaskStartCapacityCandidate[],
  input: RankCapacityCandidatesInput
): TaskStartCapacityCandidate[] {
  const settings = input.settings ?? defaultPlacementSettings();
  return [...candidates].sort((a, b) => {
    const byLocation = comparePlacementLocationsByStrategy(
      { provider: a.provider, location: a.location },
      { provider: b.provider, location: b.location },
      input.strategy,
      input.locationInventory
    );
    if (byLocation !== 0) return byLocation;
    return compareCapacityCandidates(a, b, input.strategy, input.reservation, settings);
  });
}

export function compareCapacityCandidates(
  a: TaskStartCapacityCandidate,
  b: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation,
  settings: CapacityPoolPlacementSettings = defaultPlacementSettings()
): number {
  const capacityDiff = compareOfferingCapacity(a, b);
  if (strategy === 'pack' && capacityDiff !== 0) return -capacityDiff;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (strategy === 'smallest-fit') {
    const fitDiff = compareOfferingFitSurplus(a, b, reservation);
    if (fitDiff !== 0) return fitDiff;
    const priceDiff = compareOfferingPrice(a, b);
    if (priceDiff !== 0) return priceDiff;
    if (capacityDiff !== 0) return capacityDiff;
  }
  const weighted =
    weightedCandidateScore(a, strategy, reservation, settings) -
    weightedCandidateScore(b, strategy, reservation, settings);
  if (weighted !== 0) return weighted;
  const priceDiff = compareOfferingPrice(a, b);
  if (priceDiff !== 0) return priceDiff;
  if (strategy !== 'pack' && capacityDiff !== 0) return capacityDiff;
  if (a.candidateOrder !== b.candidateOrder) return a.candidateOrder - b.candidateOrder;
  return a.id.localeCompare(b.id);
}

function weightedCandidateScore(
  candidate: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation,
  settings: CapacityPoolPlacementSettings
): number {
  const weights = settings.selectionWeights;
  const price = normalizedPriceScore(candidate);
  const fit = boundedScoreTerm(offeringFitSurplus(candidate, reservation));
  const capacity = compareOfferingCapacity(candidate, {
    providerInstanceVcpuCount: 0,
    providerInstanceMemoryMb: 0,
    providerInstanceDiskGb: 0,
  });
  const capacityTerm = strategy === 'pack' ? -capacity : capacity;
  const score =
    price * boundedWeight(weights.price) +
    fit * boundedWeight(weights.fit) +
    boundedScoreTerm(capacityTerm) * boundedWeight(weights.capacity) +
    boundedScoreTerm(candidate.candidateOrder) * boundedWeight(weights.candidateOrder);
  return Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
}

function compareOfferingCapacity(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >
): number {
  const cpuDiff = a.providerInstanceVcpuCount - b.providerInstanceVcpuCount;
  if (cpuDiff !== 0) return cpuDiff;
  const memoryDiff = a.providerInstanceMemoryMb - b.providerInstanceMemoryMb;
  if (memoryDiff !== 0) return memoryDiff;
  return (a.providerInstanceDiskGb ?? 0) - (b.providerInstanceDiskGb ?? 0);
}

function compareOfferingFitSurplus(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  return offeringFitSurplus(a, reservation) - offeringFitSurplus(b, reservation);
}

function offeringFitSurplus(
  candidate: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  const cpuBase = Math.max(1, reservation.cpuMillis);
  const memoryBase = Math.max(1, reservation.memoryMb);
  const diskBase = Math.max(1, reservation.diskMb);
  const cpuSurplus = Math.max(
    0,
    candidate.providerInstanceVcpuCount * 1000 - reservation.cpuMillis
  );
  const memorySurplus = Math.max(0, candidate.providerInstanceMemoryMb - reservation.memoryMb);
  const diskSurplus =
    candidate.providerInstanceDiskGb === null
      ? 0
      : Math.max(0, candidate.providerInstanceDiskGb * 1024 - reservation.diskMb);
  return cpuSurplus / cpuBase + memorySurplus / memoryBase + diskSurplus / diskBase;
}

function compareOfferingPrice(
  a: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
    | 'placementCredentialVersion'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): number {
  const aComparability = priceComparability(a);
  const bComparability = priceComparability(b);
  if (aComparability !== 'known' && bComparability !== 'known') return 0;
  if (aComparability !== 'known') return 1;
  if (bComparability !== 'known') return -1;
  const aPrice = comparablePriceMicros(a);
  const bPrice = comparablePriceMicros(b);
  if (aPrice === null && bPrice === null) return 0;
  if (aPrice === null) return 1;
  if (bPrice === null) return -1;
  if (aPrice.currency !== bPrice.currency) return 0;
  return aPrice.value - bPrice.value;
}

export function classifyCandidatePriceComparability(
  candidates: TaskStartCapacityCandidate[]
): TaskStartCapacityCandidate[] {
  const pricedCurrencies = new Set(
    candidates.flatMap((candidate) => {
      const price = comparablePriceMicros(candidate);
      return price ? [price.currency] : [];
    })
  );
  const hasCurrencyMismatch = pricedCurrencies.size > 1;
  return candidates.map((candidate) => {
    const price = comparablePriceMicros(candidate);
    return {
      ...candidate,
      priceComparability: price ? (hasCurrencyMismatch ? 'currency-mismatch' : 'known') : 'unknown',
    };
  });
}

export function priceComparability(
  candidate: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): TaskStartCapacityCandidate['priceComparability'] {
  return 'priceComparability' in candidate &&
    (candidate.priceComparability === 'known' ||
      candidate.priceComparability === 'unknown' ||
      candidate.priceComparability === 'currency-mismatch')
    ? candidate.priceComparability
    : comparablePriceMicros(candidate)
      ? 'known'
      : 'unknown';
}

function normalizedPriceScore(candidate: TaskStartCapacityCandidate): number {
  if (candidate.priceComparability !== 'known') return 1_000_000;
  const price = comparablePriceMicros(candidate);
  if (!price) return 1_000_000;
  return Math.min(1_000_000, price.value / 1_000);
}

function boundedScoreTerm(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER / MAX_SCORE_WEIGHT;
  return Math.max(-1_000_000_000, Math.min(1_000_000_000, value));
}

function boundedWeight(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, MAX_SCORE_WEIGHT);
}

function comparablePriceMicros(
  candidate: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): { currency: string; value: number } | null {
  const currency = nonEmptyString(candidate.providerInstancePriceCurrency);
  if (!currency) return null;
  const hourly = nonNegativeInteger(candidate.providerInstancePriceHourlyMicros);
  if (hourly !== null) return { currency, value: hourly };
  const monthly = nonNegativeInteger(candidate.providerInstancePriceMonthlyCents);
  if (monthly !== null) {
    return {
      currency,
      value: Math.round((monthly * 10_000) / resolveApproximateBillingMonthHours(null)),
    };
  }
  return null;
}

export function defaultPlacementSettings(): CapacityPoolPlacementSettings {
  return {
    ...DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS,
    source: {
      legacyWorkloadMapping: 'default',
      platformDefaults: 'default',
      selection: 'default',
    },
    diagnostics: [],
  };
}

export function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
