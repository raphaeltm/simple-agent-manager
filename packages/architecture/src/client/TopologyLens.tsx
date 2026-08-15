import type { CSSProperties } from 'react';

import type { ArchitectureElement, ArchitectureRelationship } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import { type ProjectionIndex, topologySlice } from './projections';
import type { Selection } from './types';

const NODE_WIDTH = 196;
const NODE_HEIGHT = 78;
const COLUMN_GAP = 112;
const ROW_GAP = 34;
const STAGE_PADDING = 32;
/** Maximum nodes stacked along a group's cross axis before it wraps into another line. */
const GROUP_WRAP_LIMIT = 6;
/** Gap between wrapped lines of the SAME group — deliberately tighter than COLUMN_GAP so a
 *  wrapped group still reads as one depth band rather than several. */
const GROUP_INNER_GAP = 24;
/** Vertical room reserved above a group for its label. */
const GROUP_LABEL_SPACE = 30;
/** A minimap of a handful of nodes is decoration, not navigation. */
const MINIMAP_MIN_NODES = 8;

interface TopologyLensProps {
  model: ViewerModel;
  focusId?: string;
  selection?: Selection;
  zoom: number;
  mobile: boolean;
  onSelect: (selection: Selection) => void;
  projectionIndex: ProjectionIndex;
}

interface NodePosition {
  x: number;
  y: number;
}

/**
 * A visual band of nodes that share one derived graph depth (or the trailing set of nodes that
 * have no routes at all). One group === one truthful statement about the data; a group that has
 * to wrap onto several lines is still ONE group with ONE label.
 */
interface TopologyGroup {
  height: number;
  label: string;
  width: number;
  x: number;
  y: number;
}

interface TopologyLayout {
  groups: TopologyGroup[];
  height: number;
  positions: Map<string, NodePosition>;
  /** True when at least one in-scope route exists, so depth is actually derivable from the data. */
  ranked: boolean;
  vertical: boolean;
  width: number;
}

export function TopologyLens({
  model,
  focusId,
  selection,
  zoom,
  mobile,
  onSelect,
  projectionIndex,
}: TopologyLensProps) {
  const slice = topologySlice(model, focusId, projectionIndex);
  if (slice.elements.length === 0) {
    return (
      <div className="empty-lens">
        <h2>No topology in this scope</h2>
        <p>Add architecture elements and relationships to populate this map.</p>
      </div>
    );
  }

  const layout = createTopologyLayout(slice.elements, slice.relationships, mobile);
  const elementsById = new Map(slice.elements.map((element) => [element.id, element]));
  const relatedIds = connectedElementIds(slice.relationships);
  const style: CSSProperties & Record<'--aw-zoom', string> = { '--aw-zoom': String(zoom) };

  return (
    <section className="topology-lens" aria-label="Directed system topology" style={style}>
      <TopologySummary
        elements={slice.elements}
        elementCount={slice.elements.length}
        layout={layout}
        relationshipCount={slice.relationships.length}
        omittedElementCount={slice.omittedElements}
        omittedRelationshipCount={slice.omittedRelationships}
      />
      <div className="topology-stage" style={{ height: layout.height, width: layout.width }}>
        <TopologyGroups layout={layout} />
        <TopologyEdges
          layout={layout}
          relationships={slice.relationships}
          selectedRelationship={selection?.kind === 'relationship' ? selection.id : undefined}
        />
        {slice.elements.map((element) => {
          const position = layout.positions.get(element.id);
          if (!position) return null;
          const selected = selection?.kind === 'element' && selection.id === element.id;
          return (
            <button
              key={element.id}
              type="button"
              aria-label={element.title}
              aria-pressed={selected}
              className={`topology-node topology-node--${element.kind}${selected ? ' selected' : ''}${element.id === focusId ? ' is-scope' : ''}${relatedIds.has(element.id) ? ' is-connected' : ' is-isolated'}`}
              style={{
                height: NODE_HEIGHT,
                left: position.x,
                top: position.y,
                width: NODE_WIDTH,
              }}
              onClick={() => onSelect({ kind: 'element', id: element.id })}
            >
              <small>{element.kind}</small>
              <strong>{element.title}</strong>
              <span className="topology-node-meta">
                {element.id === focusId && <b>scope</b>}
                {(element.sourceRefs?.length ?? 0) > 0 && <b>src</b>}
                {(projectionIndex.threadsByTarget.get(element.id)?.length ?? 0) > 0 && <b>q&a</b>}
                {/* Only worth flagging when the view is mixed — in an unranked view every node is
                    unconnected, so a badge on all of them is noise, and the group already says it. */}
                {layout.ranked && !relatedIds.has(element.id) && <b>isolated</b>}
              </span>
            </button>
          );
        })}
      </div>
      <TopologyConnections
        elementsById={elementsById}
        relationships={slice.relationships}
        selection={selection}
        onSelect={onSelect}
      />
      {(slice.omittedElements > 0 || slice.omittedRelationships > 0) && (
        <p className="bounded-note topology-bounded-note">
          {slice.omittedElements} additional elements and {slice.omittedRelationships} connections
          are omitted from this bounded topology.
        </p>
      )}
    </section>
  );
}

function TopologySummary({
  elements,
  elementCount,
  layout,
  relationshipCount,
  omittedElementCount,
  omittedRelationshipCount,
}: {
  elements: ArchitectureElement[];
  elementCount: number;
  layout: TopologyLayout;
  relationshipCount: number;
  omittedElementCount: number;
  omittedRelationshipCount: number;
}) {
  return (
    <header className="topology-summary">
      <div className="topology-summary-title">
        <p className="eyebrow">Topology layer</p>
        <h2>{layout.ranked ? 'Ranked by route direction' : 'No directed routes'}</h2>
        <p className="topology-legend">
          {layout.ranked
            ? 'Bands are graph depth derived from route direction. “Unconnected” has no routes in this scope.'
            : 'Nothing in this scope is connected, so no depth can be derived. Order is not meaningful.'}
        </p>
      </div>
      {/* Explicitly "in scope": the workbench status bar reports WORKSPACE totals, so unqualified
          "Nodes"/"Routes" in both places showed two different numbers under the same label. */}
      <dl>
        <div>
          <dt>Scope nodes</dt>
          <dd>{elementCount}</dd>
        </div>
        <div>
          <dt>Scope routes</dt>
          <dd>{relationshipCount}</dd>
        </div>
        {(omittedElementCount > 0 || omittedRelationshipCount > 0) && (
          <div>
            <dt>Bounded</dt>
            <dd>{omittedElementCount + omittedRelationshipCount}</dd>
          </div>
        )}
      </dl>
      {elementCount >= MINIMAP_MIN_NODES && <TopologyMiniMap layout={layout} elements={elements} />}
    </header>
  );
}

function TopologyGroups({ layout }: { layout: TopologyLayout }) {
  const labelled = layout.groups.filter((group) => group.label.length > 0);
  if (labelled.length === 0) return null;
  return (
    <div className="topology-groups" aria-hidden="true">
      {labelled.map((group) => (
        <div
          key={`${group.label}-${group.x}-${group.y}`}
          className={`topology-group${group.label === 'Unconnected' ? ' is-unconnected' : ''}`}
          style={{ height: group.height, left: group.x, top: group.y, width: group.width }}
        >
          <span className="topology-group-label">{group.label}</span>
        </div>
      ))}
    </div>
  );
}

function TopologyMiniMap({
  elements,
  layout,
}: {
  elements: ArchitectureElement[];
  layout: TopologyLayout;
}) {
  const scaleX = 92 / Math.max(1, layout.width);
  const scaleY = 52 / Math.max(1, layout.height);
  return (
    <div className="topology-minimap" aria-hidden="true">
      {elements.map((element) => {
        const position = layout.positions.get(element.id);
        if (!position) return null;
        return (
          <span
            key={element.id}
            className={`topology-minimap-node topology-minimap-node--${element.kind}`}
            style={{
              height: Math.max(3, NODE_HEIGHT * scaleY),
              left: position.x * scaleX,
              top: position.y * scaleY,
              width: Math.max(5, NODE_WIDTH * scaleX),
            }}
          />
        );
      })}
    </div>
  );
}

function TopologyEdges({
  layout,
  relationships,
  selectedRelationship,
}: {
  layout: TopologyLayout;
  relationships: ArchitectureRelationship[];
  selectedRelationship?: string;
}) {
  return (
    <svg
      className="topology-edges"
      aria-hidden="true"
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      <defs>
        <marker
          id="topology-arrow"
          markerHeight="8"
          markerWidth="8"
          orient="auto-start-reverse"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path d="M 0 0 L 8 4 L 0 8 Z" />
        </marker>
      </defs>
      {relationships.map((relationship, index) => {
        const from = layout.positions.get(relationship.from);
        const to = layout.positions.get(relationship.to);
        if (!from || !to) return null;
        return (
          <path
            key={relationship.id}
            className={
              selectedRelationship === relationship.id ? 'topology-edge selected' : 'topology-edge'
            }
            d={connectionPath(from, to, index, layout.vertical)}
            markerEnd="url(#topology-arrow)"
          />
        );
      })}
    </svg>
  );
}

function TopologyConnections({
  elementsById,
  relationships,
  selection,
  onSelect,
}: {
  elementsById: Map<string, ArchitectureElement>;
  relationships: ArchitectureRelationship[];
  selection?: Selection;
  onSelect: TopologyLensProps['onSelect'];
}) {
  return (
    <section className="topology-connections" aria-label="Topology connections">
      <header>
        <p className="eyebrow">Connection index</p>
        <h2>Directed routes</h2>
      </header>
      {relationships.length === 0 ? (
        <p className="muted">No directed relationships are defined in this scope.</p>
      ) : (
        <div className="topology-connection-grid">
          {relationships.map((relationship) => {
            const selected = selection?.kind === 'relationship' && selection.id === relationship.id;
            const title = relationship.title ?? relationship.id;
            return (
              <button
                key={relationship.id}
                type="button"
                aria-label={`Inspect ${title} connection`}
                aria-pressed={selected}
                className={`topology-connection${selected ? ' selected' : ''}`}
                onClick={() => onSelect({ kind: 'relationship', id: relationship.id })}
              >
                <span>
                  {elementsById.get(relationship.from)?.title ?? relationship.from}
                  <b aria-hidden="true">→</b>
                  {elementsById.get(relationship.to)?.title ?? relationship.to}
                </span>
                <small>{title}</small>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Splits the slice into depth-ranked groups.
 *
 * Only elements that actually participate in an in-scope route are ranked; everything else is
 * reported as "Unconnected" rather than being silently folded into depth 1. When there are no
 * in-scope routes at all, no depth exists in the data, so a single unlabelled group is returned
 * and `ranked` is false — callers must not present that as a layered architecture.
 */
export function buildTopologyGroups(
  elements: ArchitectureElement[],
  relationships: ArchitectureRelationship[]
): { groups: Array<{ ids: string[]; label: string }>; ranked: boolean } {
  const elementOrder = new Map(elements.map((element, index) => [element.id, index]));
  const inScope = relationships.filter(
    (relationship) => elementOrder.has(relationship.from) && elementOrder.has(relationship.to)
  );
  const connectedIds = connectedElementIds(inScope);
  const connected = elements.filter((element) => connectedIds.has(element.id));
  const isolated = elements.filter((element) => !connectedIds.has(element.id));

  if (connected.length === 0) {
    return { groups: [{ ids: elements.map((element) => element.id), label: '' }], ranked: false };
  }

  const ranks = rankElements(connected, inScope, elementOrder);
  const byRank = new Map<number, string[]>();
  for (const element of connected) {
    const rank = ranks.get(element.id) ?? 0;
    const bucket = byRank.get(rank) ?? [];
    bucket.push(element.id);
    byRank.set(rank, bucket);
  }

  const groups = [...byRank.entries()]
    .sort(([left], [right]) => left - right)
    .map(([rank, ids]) => ({ ids, label: rank === 0 ? 'Sources' : `Depth ${rank + 1}` }));
  if (isolated.length > 0) {
    groups.push({ ids: isolated.map((element) => element.id), label: 'Unconnected' });
  }
  return { groups, ranked: true };
}

/** Condenses cycles into strongly connected components, then ranks those by longest path. */
function rankElements(
  elements: ArchitectureElement[],
  relationships: ArchitectureRelationship[],
  elementOrder: Map<string, number>
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const element of elements) outgoing.set(element.id, []);
  for (const relationship of relationships) {
    if (!outgoing.has(relationship.from) || !outgoing.has(relationship.to)) continue;
    outgoing.get(relationship.from)?.push(relationship.to);
  }

  const components = stronglyConnectedComponents(
    elements.map((element) => element.id),
    outgoing
  );
  const componentByElement = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    for (const id of component) componentByElement.set(id, componentIndex);
  });
  const componentOrder = components.map((component) =>
    Math.min(...component.map((id) => elementOrder.get(id) ?? Number.MAX_SAFE_INTEGER))
  );
  const componentEdges = components.map(() => new Set<number>());
  const indegrees = components.map(() => 0);
  for (const relationship of relationships) {
    const from = componentByElement.get(relationship.from);
    const to = componentByElement.get(relationship.to);
    if (from === undefined || to === undefined || from === to || componentEdges[from]?.has(to)) {
      continue;
    }
    componentEdges[from]?.add(to);
    indegrees[to] = (indegrees[to] ?? 0) + 1;
  }

  const ranks = components.map(() => 0);
  const queue = indegrees
    .map((indegree, componentIndex) => ({ componentIndex, indegree }))
    .filter(({ indegree }) => indegree === 0)
    .map(({ componentIndex }) => componentIndex)
    .sort((left, right) => (componentOrder[left] ?? 0) - (componentOrder[right] ?? 0));
  while (queue.length > 0) {
    const component = queue.shift();
    if (component === undefined) continue;
    for (const target of componentEdges[component] ?? []) {
      ranks[target] = Math.max(ranks[target] ?? 0, (ranks[component] ?? 0) + 1);
      indegrees[target] = (indegrees[target] ?? 1) - 1;
      if (indegrees[target] === 0) {
        queue.push(target);
        queue.sort((left, right) => (componentOrder[left] ?? 0) - (componentOrder[right] ?? 0));
      }
    }
  }

  const ranksById = new Map<string, number>();
  for (const element of elements) {
    const component = componentByElement.get(element.id) ?? 0;
    ranksById.set(element.id, ranks[component] ?? 0);
  }
  return ranksById;
}

function chunk<T>(items: T[], size: number): T[][] {
  const lines: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    lines.push(items.slice(index, index + size));
  }
  return lines;
}

export function createTopologyLayout(
  elements: ArchitectureElement[],
  relationships: ArchitectureRelationship[],
  vertical: boolean
): TopologyLayout {
  const { groups, ranked } = buildTopologyGroups(elements, relationships);
  return vertical ? layoutVertical(groups, ranked) : layoutHorizontal(groups, ranked);
}

/**
 * Desktop: groups run left to right, each group wrapping downward into extra lines when it
 * exceeds GROUP_WRAP_LIMIT. Wrapped lines stay inside the group's own bounding box.
 */
function layoutHorizontal(
  groups: Array<{ ids: string[]; label: string }>,
  ranked: boolean
): TopologyLayout {
  const positions = new Map<string, NodePosition>();
  const placed: TopologyGroup[] = [];
  const maximumRows = Math.max(
    1,
    ...groups.map((group) => Math.min(group.ids.length, GROUP_WRAP_LIMIT))
  );
  const contentTop = STAGE_PADDING + GROUP_LABEL_SPACE;
  const contentHeight = maximumRows * NODE_HEIGHT + Math.max(0, maximumRows - 1) * ROW_GAP;

  let cursorX = STAGE_PADDING;
  for (const group of groups) {
    const lines = chunk(group.ids, GROUP_WRAP_LIMIT);
    const groupRows = Math.min(group.ids.length, GROUP_WRAP_LIMIT);
    const groupHeight = groupRows * NODE_HEIGHT + Math.max(0, groupRows - 1) * ROW_GAP;
    const centerOffset = (contentHeight - groupHeight) / 2;
    const groupWidth = lines.length * NODE_WIDTH + Math.max(0, lines.length - 1) * GROUP_INNER_GAP;

    for (const [lineIndex, line] of lines.entries()) {
      const x = cursorX + lineIndex * (NODE_WIDTH + GROUP_INNER_GAP);
      for (const [rowIndex, id] of line.entries()) {
        positions.set(id, {
          x,
          y: contentTop + centerOffset + rowIndex * (NODE_HEIGHT + ROW_GAP),
        });
      }
    }
    placed.push({
      height: groupHeight + GROUP_LABEL_SPACE,
      label: group.label,
      width: groupWidth,
      x: cursorX,
      y: contentTop + centerOffset - GROUP_LABEL_SPACE,
    });
    cursorX += groupWidth + COLUMN_GAP;
  }

  return {
    groups: placed,
    height: contentTop + contentHeight + STAGE_PADDING,
    positions,
    ranked,
    vertical: false,
    width: Math.max(STAGE_PADDING * 2 + NODE_WIDTH, cursorX - COLUMN_GAP + STAGE_PADDING),
  };
}

/**
 * Mobile: the SAME derived groups, stacked top to bottom so routes read downward. This layout
 * previously ignored relationships entirely and stacked elements in document order, which drew
 * edges between arbitrary neighbours; depth is now real on mobile too.
 */
function layoutVertical(
  groups: Array<{ ids: string[]; label: string }>,
  ranked: boolean
): TopologyLayout {
  const positions = new Map<string, NodePosition>();
  const placed: TopologyGroup[] = [];
  let cursorY = STAGE_PADDING;

  for (const group of groups) {
    const contentTop = cursorY + GROUP_LABEL_SPACE;
    for (const [index, id] of group.ids.entries()) {
      positions.set(id, { x: STAGE_PADDING, y: contentTop + index * (NODE_HEIGHT + ROW_GAP) });
    }
    const groupHeight =
      group.ids.length * NODE_HEIGHT + Math.max(0, group.ids.length - 1) * ROW_GAP;
    placed.push({
      height: groupHeight + GROUP_LABEL_SPACE,
      label: group.label,
      width: NODE_WIDTH,
      x: STAGE_PADDING,
      y: cursorY,
    });
    cursorY = contentTop + groupHeight + ROW_GAP * 2;
  }

  return {
    groups: placed,
    height: Math.max(STAGE_PADDING * 2 + NODE_HEIGHT, cursorY - ROW_GAP * 2 + STAGE_PADDING),
    positions,
    ranked,
    vertical: true,
    width: STAGE_PADDING * 2 + NODE_WIDTH,
  };
}

function connectedElementIds(relationships: ArchitectureRelationship[]): Set<string> {
  const ids = new Set<string>();
  for (const relationship of relationships) {
    ids.add(relationship.from);
    ids.add(relationship.to);
  }
  return ids;
}

function stronglyConnectedComponents(ids: string[], outgoing: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const components: string[][] = [];

  function visit(id: string): void {
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    inStack.add(id);

    for (const target of outgoing.get(id) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, lowLinks.get(target) ?? 0));
      } else if (inStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, indexes.get(target) ?? 0));
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (!current) break;
      inStack.delete(current);
      component.push(current);
    } while (current !== id);
    components.push(component);
  }

  for (const id of ids) {
    if (!indexes.has(id)) visit(id);
  }
  return components;
}

function connectionPath(
  from: NodePosition,
  to: NodePosition,
  index: number,
  vertical: boolean
): string {
  const bend = 28 + (index % 3) * 12;
  if (vertical) {
    const fromX = from.x + NODE_WIDTH / 2;
    const fromY = from.y + NODE_HEIGHT;
    const toX = to.x + NODE_WIDTH / 2;
    const toY = to.y;
    if (from.y === to.y) {
      const sideY = fromY + COLUMN_GAP / 2 + bend;
      return `M ${fromX} ${fromY} C ${fromX} ${sideY}, ${toX} ${sideY}, ${toX} ${toY + NODE_HEIGHT}`;
    }
    const middleY = fromY + (toY - fromY) / 2;
    return `M ${fromX} ${fromY} C ${fromX} ${middleY}, ${toX} ${middleY}, ${toX} ${toY}`;
  }
  const fromX = from.x + NODE_WIDTH;
  const fromY = from.y + NODE_HEIGHT / 2;
  const toX = to.x;
  const toY = to.y + NODE_HEIGHT / 2;
  if (from.x === to.x) {
    const sideX = fromX + COLUMN_GAP / 2 + bend;
    return `M ${fromX} ${fromY} C ${sideX} ${fromY}, ${sideX} ${toY}, ${toX + NODE_WIDTH} ${toY}`;
  }
  const middleX = fromX + (toX - fromX) / 2;
  return `M ${fromX} ${fromY} C ${middleX} ${fromY}, ${middleX} ${toY}, ${toX} ${toY}`;
}
