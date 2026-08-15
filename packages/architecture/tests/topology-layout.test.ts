import { describe, expect, it } from 'vitest';

import { buildTopologyGroups, createTopologyLayout } from '../src/client/TopologyLens';
import type { ArchitectureElement, ArchitectureRelationship } from '../src/schemas';

/**
 * These tests pin the topology lens to what the data actually supports. The lens previously
 * asserted meaning the model never carried:
 *   - rank 0/1 were hardcoded as "Entry"/"Runtime" (a domain claim, not a graph fact)
 *   - a rank wider than the wrap limit was split into "Entry.1 / Entry.2 / Entry.3", so pagination
 *     rendered as if it were architectural tiers
 *   - the mobile layout ignored relationships entirely and stacked nodes in document order
 * Each test below fails against that prior behaviour.
 */

function element(id: string, kind: ArchitectureElement['kind'] = 'component'): ArchitectureElement {
  return { id, kind, title: `Title ${id}` };
}

function route(from: string, to: string): ArchitectureRelationship {
  return { id: `${from}-${to}`, from, to };
}

describe('topology grouping', () => {
  it('labels bands by derived graph depth, never by an invented domain role', () => {
    const { groups, ranked } = buildTopologyGroups(
      [element('api'), element('worker', 'runtime')],
      [route('api', 'worker')]
    );

    expect(ranked).toBe(true);
    expect(groups.map((group) => group.label)).toEqual(['Sources', 'Depth 2']);
    // The prior implementation named these "Entry" and "Runtime".
    for (const group of groups) {
      expect(group.label).not.toMatch(/entry|runtime|hop/i);
    }
  });

  it('keeps one rank as ONE band when it is too wide to fit and must wrap', () => {
    const sources = Array.from({ length: 8 }, (_, index) => element(`source-${index}`));
    const routes = sources.map((source) => route(source.id, 'sink'));
    const { groups } = buildTopologyGroups([...sources, element('sink')], routes);

    // 8 sources exceed the 6-per-line wrap limit, but they are still a single depth.
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.label)).toEqual(['Sources', 'Depth 2']);
    expect(groups[0]?.ids).toHaveLength(8);
    // Prior behaviour produced suffixed pseudo-tiers.
    expect(groups.some((group) => /\.\d+$/.test(group.label))).toBe(false);

    // The wrapped band is laid out as one bounding box spanning both of its lines.
    const layout = createTopologyLayout([...sources, element('sink')], routes, false);
    const labelled = layout.groups.filter((group) => group.label.length > 0);
    expect(labelled).toHaveLength(2);
    expect(labelled[0]?.width).toBeGreaterThan(labelled[1]?.width ?? 0);
  });

  it('refuses to rank anything when the scope has no routes', () => {
    const elements = Array.from({ length: 36 }, (_, index) => element(`node-${index}`));
    const { groups, ranked } = buildTopologyGroups(elements, []);

    expect(ranked).toBe(false);
    expect(groups).toHaveLength(1);
    // No label at all — an unlabelled band cannot imply a tier that does not exist.
    expect(groups[0]?.label).toBe('');
    expect(groups[0]?.ids).toHaveLength(36);

    const layout = createTopologyLayout(elements, [], false);
    expect(layout.ranked).toBe(false);
    expect(layout.groups.every((group) => group.label === '')).toBe(true);
    expect(layout.positions.size).toBe(36);
  });

  it('separates elements that have no routes instead of folding them into depth 1', () => {
    const elements = [element('api'), element('worker', 'runtime'), element('orphan')];
    const { groups } = buildTopologyGroups(elements, [route('api', 'worker')]);

    expect(groups.map((group) => group.label)).toEqual(['Sources', 'Depth 2', 'Unconnected']);
    expect(groups.at(-1)?.ids).toEqual(['orphan']);
    expect(groups[0]?.ids).toEqual(['api']);
  });

  it('ignores routes whose endpoints are outside the current slice', () => {
    const { groups, ranked } = buildTopologyGroups(
      [element('api')],
      [route('api', 'not-in-slice')]
    );

    expect(ranked).toBe(false);
    expect(groups[0]?.ids).toEqual(['api']);
  });

  it('condenses a cycle into a single depth rather than looping forever', () => {
    const { groups, ranked } = buildTopologyGroups(
      [element('a'), element('b'), element('c')],
      [route('a', 'b'), route('b', 'a'), route('b', 'c')]
    );

    expect(ranked).toBe(true);
    expect(groups[0]?.ids).toEqual(expect.arrayContaining(['a', 'b']));
    expect(groups.at(-1)?.ids).toEqual(['c']);
  });
});

describe('mobile (vertical) topology layout', () => {
  it('orders by route direction, not document order', () => {
    // Document order is deliberately reversed: the sink is declared before the source.
    const elements = [element('worker', 'runtime'), element('api')];
    const routes = [route('api', 'worker')];

    const layout = createTopologyLayout(elements, routes, true);

    expect(layout.vertical).toBe(true);
    expect(layout.ranked).toBe(true);
    const api = layout.positions.get('api');
    const worker = layout.positions.get('worker');
    // The source must sit ABOVE the node it routes into. The prior vertical layout stacked in
    // array order, which would place 'worker' first and draw the edge upward.
    expect(api?.y).toBeLessThan(worker?.y ?? 0);
  });

  it('derives the same bands as the desktop layout', () => {
    const elements = [element('api'), element('worker', 'runtime'), element('orphan')];
    const routes = [route('api', 'worker')];

    const vertical = createTopologyLayout(elements, routes, true);
    const horizontal = createTopologyLayout(elements, routes, false);

    expect(vertical.groups.map((group) => group.label)).toEqual(
      horizontal.groups.map((group) => group.label)
    );
    expect(vertical.groups.map((group) => group.label)).toEqual([
      'Sources',
      'Depth 2',
      'Unconnected',
    ]);
  });

  it('stacks bands top to bottom without overlapping', () => {
    const elements = [element('api'), element('worker', 'runtime'), element('orphan')];
    const layout = createTopologyLayout(elements, [route('api', 'worker')], true);

    const tops = layout.groups.map((group) => group.y);
    expect([...tops].sort((left, right) => left - right)).toEqual(tops);
    for (const [index, group] of layout.groups.entries()) {
      const next = layout.groups[index + 1];
      if (next) expect(group.y + group.height).toBeLessThanOrEqual(next.y);
    }
    expect(layout.height).toBeGreaterThan(0);
  });
});
