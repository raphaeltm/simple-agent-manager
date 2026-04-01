import type { Edge,Node } from '@xyflow/react';
import dagre from 'dagre';

interface LayoutOptions {
  direction?: 'TB' | 'LR';
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

/**
 * Apply dagre hierarchical layout to React Flow nodes and edges.
 * Returns new node array with computed positions.
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {}
): Node[] {
  const {
    direction = 'TB',
    nodeWidth = 220,
    nodeHeight = 100,
    rankSep = 80,
    nodeSep = 40,
  } = options;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: rankSep, nodesep: nodeSep });

  for (const node of nodes) {
    // Use different sizes for different node types
    const width = node.type === 'projectNode' ? 260 : nodeWidth;
    const height = node.type === 'projectNode' ? 140 : nodeHeight;
    g.setNode(node.id, { width, height });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const nodeWithPosition = g.node(node.id);
    const width = node.type === 'projectNode' ? 260 : nodeWidth;
    const height = node.type === 'projectNode' ? 140 : nodeHeight;

    return {
      ...node,
      position: {
        x: nodeWithPosition.x - width / 2,
        y: nodeWithPosition.y - height / 2,
      },
    };
  });
}
