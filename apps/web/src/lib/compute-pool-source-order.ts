import type { DefaultCapacityPoolSummary } from '@simple-agent-manager/shared';
import { MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH } from '@simple-agent-manager/shared';

import { groupTitles } from '../components/compute-pool/machine-labels';
import { type MachineGroup, sourceKind } from './compute-pool-machines';
import { providerDisplayName } from './compute-pool-offering-fields';

/** A capacity source the pool's provider order may list. */
export interface OrderableSource {
  id: string;
  /** Short name for sentences: the provider, or the full title when two sources share it. */
  label: string;
  /** Provider plus where the account is managed, matching the machine list headings. */
  title: string;
  allowedMachineCount: number;
}

/**
 * Sources the server accepts in `sourceOrder`: mirrors `resolveSourceOrderUpdate` in
 * `default-capacity-pool-updates.ts`, which requires a non-deleted candidate in this pool.
 */
export function orderableSources(
  summary: DefaultCapacityPoolSummary,
  groups: MachineGroup[]
): OrderableSource[] {
  const serving = new Set(
    summary.candidates
      .filter((candidate) => candidate.status !== 'deleted')
      .map((candidate) => candidate.capacitySourceId)
  );
  const groupsById = new Map(groups.map((group) => [group.key, group]));
  // A source the loaded catalog has no machines for still gets a heading of its own.
  const sourceGroups: MachineGroup[] = summary.sources
    .filter((source) => serving.has(source.id))
    .map(
      (source) =>
        groupsById.get(source.id) ?? {
          key: source.id,
          provider: source.provider ?? '',
          providerLabel: providerDisplayName(source.provider),
          kind: sourceKind(source),
          credentialSource: source.credentialSource,
          label: source.label ?? null,
          rows: [],
        }
    );
  const titles = groupTitles(sourceGroups);
  const providerCounts = new Map<string, number>();
  for (const group of sourceGroups) {
    providerCounts.set(group.providerLabel, (providerCounts.get(group.providerLabel) ?? 0) + 1);
  }
  return sourceGroups.map((group) => {
    const title = titles.get(group.key) ?? group.providerLabel;
    return {
      id: group.key,
      label: (providerCounts.get(group.providerLabel) ?? 0) > 1 ? title : group.providerLabel,
      title,
      allowedMachineCount: summary.candidates.filter(
        (candidate) => candidate.capacitySourceId === group.key && candidate.status === 'active'
      ).length,
    };
  });
}

/**
 * Splits sources into the ranked ones, in order, and the ones the order does not list, which
 * placement tries after every ranked source. Ids that no longer serve the pool are dropped.
 */
export function rankSources(sources: OrderableSource[], sourceOrder: string[] | null | undefined) {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const ranked = (sourceOrder ?? []).flatMap((id) => byId.get(id) ?? []);
  const rankedIds = new Set(ranked.map((source) => source.id));
  return { ranked, unranked: sources.filter((source) => !rankedIds.has(source.id)) };
}

/**
 * The editor's starting order: null when no order is stored, otherwise every orderable source
 * with unranked ones appended, so saving without a change writes nothing new. A stored order
 * whose sources no longer serve the pool still opens as ordered, so it can be cleared.
 */
export function initialSourceOrder(
  sources: OrderableSource[],
  sourceOrder: string[] | null | undefined
): string[] | null {
  if (!sourceOrder || sourceOrder.length === 0) return null;
  const { ranked, unranked } = rankSources(sources, sourceOrder);
  return [...ranked, ...unranked].map((source) => source.id);
}

/**
 * The `sourceOrder` to send. The API lists at most MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH sources;
 * any beyond that stay unranked, which placement already tries after every ranked source.
 */
export function toSourceOrderRequest(order: string[] | null): string[] | null {
  return order ? order.slice(0, MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH) : null;
}

export function sameSourceOrder(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
