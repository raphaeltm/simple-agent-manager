/** List helpers for resource-link context reads (`./link-core.ts`). */
import type { CappedList, LinkKind, LinkRelation } from '@simple-agent-manager/shared';
import { isStrongLinkRelation } from '@simple-agent-manager/shared';

import type { ResourceLink } from './port-types';

/** The first `cap` items, with the total and whether the list was cut. */
export function capped<T>(
  items: T[],
  cap: number,
  total = items.length,
  incomplete = false
): CappedList<T> {
  const count = Math.max(items.length, total);
  return {
    items: items.slice(0, cap),
    total: count,
    truncated: incomplete || count > cap,
    totalIsLowerBound: incomplete,
  };
}

export function linkFor(links: ResourceLink[], kind: LinkKind, id: string) {
  return links.filter(
    (l) =>
      (l.sourceKind === kind && l.sourceId === id) || (l.targetKind === kind && l.targetId === id)
  );
}

export function sorted(links: ResourceLink[]) {
  return [...links].sort(
    (a, b) =>
      Number(isStrongLinkRelation(b.relation)) - Number(isStrongLinkRelation(a.relation)) ||
      b.lastAt - a.lastAt
  );
}

export function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function mergeRelations<T extends { relations: LinkRelation[] }>(
  items: T[],
  key: (item: T) => string
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const current = map.get(id);
    if (current) {
      for (const relation of item.relations)
        if (!current.relations.includes(relation)) current.relations.push(relation);
    } else map.set(id, item);
  }
  return [...map.values()];
}
