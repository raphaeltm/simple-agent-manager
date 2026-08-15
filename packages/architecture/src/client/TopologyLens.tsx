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
const DENSE_COLUMN_LIMIT = 6;

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

interface TopologyLayout {
  height: number;
  positions: Map<string, NodePosition>;
  rankLabels: Array<{ label: string; x: number; width: number }>;
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
        <TopologyLanes layout={layout} />
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
                {!relatedIds.has(element.id) && <b>isolated</b>}
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
      <div>
        <p className="eyebrow">Topology layer</p>
        <h2>Runtime routes</h2>
      </div>
      <dl>
        <div>
          <dt>Nodes</dt>
          <dd>{elementCount}</dd>
        </div>
        <div>
          <dt>Routes</dt>
          <dd>{relationshipCount}</dd>
        </div>
        {(omittedElementCount > 0 || omittedRelationshipCount > 0) && (
          <div>
            <dt>Bounded</dt>
            <dd>{omittedElementCount + omittedRelationshipCount}</dd>
          </div>
        )}
      </dl>
      <TopologyMiniMap layout={layout} elements={elements} />
    </header>
  );
}

function TopologyLanes({ layout }: { layout: TopologyLayout }) {
  return (
    <div className="topology-lanes" aria-hidden="true">
      {layout.rankLabels.map((rank) => (
        <span
          key={`${rank.label}-${rank.x}`}
          className="topology-lane"
          style={{ left: rank.x, width: rank.width }}
        >
          {rank.label}
        </span>
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

function createTopologyLayout(
  elements: ArchitectureElement[],
  relationships: ArchitectureRelationship[],
  vertical: boolean
): TopologyLayout {
  if (vertical) return createVerticalTopologyLayout(elements);

  const elementOrder = new Map(elements.map((element, index) => [element.id, index]));
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

  const columns = new Map<number, string[]>();
  for (const element of elements) {
    const component = componentByElement.get(element.id) ?? 0;
    const rank = ranks[component] ?? 0;
    const column = columns.get(rank) ?? [];
    column.push(element.id);
    columns.set(rank, column);
  }
  const packedColumns = packDenseColumns(columns);
  const maximumRows = Math.max(1, ...packedColumns.map((column) => column.ids.length));
  const positions = new Map<string, NodePosition>();
  const rankLabels: TopologyLayout['rankLabels'] = [];
  for (const [columnIndex, column] of packedColumns.entries()) {
    const columnOffset = ((maximumRows - column.ids.length) * (NODE_HEIGHT + ROW_GAP)) / 2;
    const x = STAGE_PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP);
    rankLabels.push({ label: column.label, x, width: NODE_WIDTH });
    for (const [rowIndex, id] of column.ids.entries()) {
      positions.set(id, {
        x,
        y: STAGE_PADDING + columnOffset + rowIndex * (NODE_HEIGHT + ROW_GAP),
      });
    }
  }

  return {
    height: STAGE_PADDING * 2 + maximumRows * NODE_HEIGHT + Math.max(0, maximumRows - 1) * ROW_GAP,
    positions,
    rankLabels,
    vertical: false,
    width:
      STAGE_PADDING * 2 +
      packedColumns.length * NODE_WIDTH +
      Math.max(0, packedColumns.length - 1) * COLUMN_GAP,
  };
}

function createVerticalTopologyLayout(elements: ArchitectureElement[]): TopologyLayout {
  return {
    height:
      STAGE_PADDING * 2 +
      elements.length * NODE_HEIGHT +
      Math.max(0, elements.length - 1) * ROW_GAP,
    positions: new Map(
      elements.map((element, index) => [
        element.id,
        { x: STAGE_PADDING, y: STAGE_PADDING + index * (NODE_HEIGHT + ROW_GAP) },
      ])
    ),
    rankLabels: [{ label: 'Stack', x: STAGE_PADDING, width: NODE_WIDTH }],
    vertical: true,
    width: STAGE_PADDING * 2 + NODE_WIDTH,
  };
}

function packDenseColumns(columns: Map<number, string[]>): Array<{ ids: string[]; label: string }> {
  return [...columns.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([rank, ids]) => {
      if (ids.length <= DENSE_COLUMN_LIMIT) return [{ ids, label: rankLabel(rank) }];
      const packed: Array<{ ids: string[]; label: string }> = [];
      for (let index = 0; index < ids.length; index += DENSE_COLUMN_LIMIT) {
        packed.push({
          ids: ids.slice(index, index + DENSE_COLUMN_LIMIT),
          label: `${rankLabel(rank)}.${packed.length + 1}`,
        });
      }
      return packed;
    });
}

function rankLabel(rank: number): string {
  if (rank === 0) return 'Entry';
  if (rank === 1) return 'Runtime';
  return `Hop ${rank}`;
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
