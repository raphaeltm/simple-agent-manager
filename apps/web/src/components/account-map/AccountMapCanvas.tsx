import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeTypes,
  MiniMap,
  type Node,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { type FC, useCallback, useEffect, useRef,useState } from 'react';

import { AnimatedFlowEdge } from './edges/AnimatedFlowEdge';
import { IdeaNode } from './nodes/IdeaNode';
import { NodeVMNode } from './nodes/NodeVMNode';
import { ProjectNode } from './nodes/ProjectNode';
import { SessionNode } from './nodes/SessionNode';
import { TaskNode } from './nodes/TaskNode';
import { WorkspaceNode } from './nodes/WorkspaceNode';

/** Delay before hiding tooltip after mouse leaves a node (ms). */
const TOOLTIP_HIDE_DELAY_MS = 100;

interface AccountMapCanvasProps {
  nodes: Node[];
  edges: Edge[];
  isMobile: boolean;
}

function TooltipDetails({ data }: { data: Record<string, unknown> }) {
  const fields: Array<{ label: string; value: string }> = [];
  if (data.status) fields.push({ label: 'Status', value: String(data.status) });
  if (data.repository) fields.push({ label: 'Repo', value: String(data.repository) });
  if (data.branch) fields.push({ label: 'Branch', value: String(data.branch) });
  if (data.ipAddress) fields.push({ label: 'IP', value: String(data.ipAddress) });
  if (data.messageCount != null) fields.push({ label: 'Messages', value: String(data.messageCount) });
  if (data.executionStep) fields.push({ label: 'Step', value: String(data.executionStep) });
  return (
    <div className="flex flex-col gap-0.5 sam-type-caption text-fg-muted">
      {fields.map((f) => (
        <span key={f.label} className="truncate">{f.label}: {f.value}</span>
      ))}
    </div>
  );
}

const NODE_TYPES: NodeTypes = {
  projectNode: ProjectNode,
  nodeVMNode: NodeVMNode,
  workspaceNode: WorkspaceNode,
  sessionNode: SessionNode,
  taskNode: TaskNode,
  ideaNode: IdeaNode,
};

const EDGE_TYPES: EdgeTypes = {
  animatedFlow: AnimatedFlowEdge,
};

function AccountMapCanvasInner({ nodes: initialNodes, edges: initialEdges, isMobile }: AccountMapCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: Node } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync external changes
  useEffect(() => {
    setNodes(initialNodes);
  }, [initialNodes, setNodes]);
  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  const handleNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (isMobile) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setTooltip({ x: _event.clientX + 12, y: _event.clientY + 12, node });
    },
    [isMobile]
  );

  const handleNodeMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setTooltip(null), TOOLTIP_HIDE_DELAY_MS);
  }, []);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!isMobile) return;
      // On mobile, show tooltip on tap
      setTooltip((prev) =>
        prev?.node.id === node.id ? null : { x: 0, y: 0, node }
      );
    },
    [isMobile]
  );

  const handlePaneClick = useCallback(() => {
    setTooltip(null);
  }, []);

  return (
    <div className="relative w-full h-full" role="region" aria-label="Account map visualization">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange as OnNodesChange<Node>}
        onEdgesChange={onEdgesChange as OnEdgesChange<Edge>}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'animatedFlow' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--sam-color-border-default)" />
        {!isMobile && (
          <>
            <MiniMap
              style={{ background: 'var(--sam-color-bg-inset)' }}
              maskColor="rgba(0, 0, 0, 0.5)"
              nodeStrokeWidth={2}
            />
            <Controls
              showInteractive={false}
              style={{ background: 'var(--sam-color-bg-surface)', border: '1px solid var(--sam-color-border-default)' }}
            />
          </>
        )}
      </ReactFlow>

      {/* Tooltip */}
      {tooltip && (
        <div
          className={`fixed z-dropdown bg-surface border border-border-default rounded-lg px-3 py-2 shadow-lg pointer-events-none max-w-[260px] ${
            isMobile ? 'left-4 right-4' : ''
          }`}
          style={
            isMobile
              ? { bottom: 'max(1rem, env(safe-area-inset-bottom, 1rem))' }
              : { left: tooltip.x, top: tooltip.y }
          }
        >
          <div className="sam-type-secondary text-fg-primary font-medium mb-1 truncate">
            {(tooltip.node.data?.label as string) ?? 'Entity'}
          </div>
          <TooltipDetails data={tooltip.node.data as Record<string, unknown>} />
        </div>
      )}

      {/* Keyboard hint — desktop only */}
      {!isMobile && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 sam-type-caption text-fg-muted bg-surface/80 px-2 py-1 rounded border border-border-default backdrop-blur-sm whitespace-nowrap">
          Drag nodes to rearrange &middot; Scroll to zoom
        </div>
      )}
    </div>
  );
}

export const AccountMapCanvas: FC<AccountMapCanvasProps> = (props) => (
  <ReactFlowProvider>
    <AccountMapCanvasInner {...props} />
  </ReactFlowProvider>
);
