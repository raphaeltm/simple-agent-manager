/**
 * PROTOTYPE ONLY — graph view of a run (desktop). Reuses the Account Map's
 * stack: @xyflow/react, the real applyDagreLayout (top-to-bottom for narrow
 * plans, left-to-right for wide fan-outs) and the real AnimatedFlowEdge. Particles flow along an edge while the work it feeds is
 * running, so "what is moving right now" is visible at a glance.
 */
import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import { Hand } from 'lucide-react';
import { type FC, useMemo } from 'react';

import { AnimatedFlowEdge } from '../../components/account-map/edges/AnimatedFlowEdge';
import { applyDagreLayout } from '../../components/account-map/layout/dagre-layout';
import { PROFILES } from './mock-world';
import { layerSteps, type RunDef, type RunFrame, type StepStatus } from './model';
import { STEP_META, StepIcon } from './status-ui';

interface StepNodeData {
  dir: 'TB' | 'LR';
  title: string;
  number: number;
  status: StepStatus;
  profile: string | null;
  approval: boolean;
  duration?: string;
  selected: boolean;
  [key: string]: unknown;
}

const NODE_W = 220;
const NODE_H = 78;

const StepNode: FC<NodeProps> = ({ data }) => {
  const d = data as unknown as StepNodeData;
  const meta = STEP_META[d.status];
  const accent =
    d.status === 'needs_you'
      ? 'var(--sam-color-warning)'
      : d.status === 'failed' || d.status === 'rejected'
        ? 'var(--sam-color-danger)'
        : d.status === 'running' || d.status === 'starting'
          ? 'var(--sam-color-success)'
          : null;
  return (
    <div
      className="rounded-lg border px-3 py-2 cursor-pointer"
      style={{
        width: NODE_W,
        minHeight: NODE_H,
        background: d.approval
          ? 'color-mix(in srgb, var(--sam-color-warning) 8%, var(--sam-color-bg-inset))'
          : 'var(--sam-color-bg-inset)',
        borderColor: d.selected
          ? 'var(--sam-color-accent-primary)'
          : (accent ?? 'var(--sam-color-border-default)'),
        borderStyle: d.approval && d.status === 'waiting' ? 'dashed' : 'solid',
        boxShadow: accent
          ? `0 0 14px -4px color-mix(in srgb, ${accent} 60%, transparent)`
          : undefined,
        opacity: ['waiting', 'cancelled', 'skipped', 'blocked'].includes(d.status) ? 0.78 : 1,
      }}
    >
      <Handle
        type="target"
        position={d.dir === 'TB' ? Position.Top : Position.Left}
        className="!w-2 !h-2 !bg-[var(--sam-color-border-default)] !border-none"
      />
      <Handle
        type="source"
        position={d.dir === 'TB' ? Position.Bottom : Position.Right}
        className="!w-2 !h-2 !bg-[var(--sam-color-border-default)] !border-none"
      />
      <div className="flex items-start gap-2">
        <span className="pt-0.5">
          <StepIcon status={d.status} size={15} />
        </span>
        <span className="text-[13px] font-medium leading-snug text-fg-primary line-clamp-2 break-words">
          <span className="tabular-nums text-fg-muted mr-1">{d.number}</span>
          {d.title}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg-muted pl-[23px]">
        {d.approval ? (
          <span
            className="inline-flex items-center gap-1"
            style={{ color: 'var(--sam-color-warning-fg)' }}
          >
            <Hand size={11} aria-hidden /> You
          </span>
        ) : (
          <span className="truncate">{d.profile}</span>
        )}
        <span>·</span>
        <span className="shrink-0" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {d.duration && <span className="ml-auto shrink-0 tabular-nums">{d.duration}</span>}
      </div>
    </div>
  );
};

// Hoisted on purpose: React Flow treats a new object here as new node/edge
// types and remounts every node (see rule 64).
const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { flow: AnimatedFlowEdge };

const DONE: StepStatus[] = ['done', 'approved', 'skipped'];

/** What an edge says: work flowing now, a finished path, a failure, or nothing yet. */
function edgeStyle(
  from: StepStatus,
  to: StepStatus
): { data: { active: boolean; color: string }; style?: React.CSSProperties } {
  if (from === 'failed' || from === 'rejected') {
    return {
      data: { active: false, color: '#ef4444' },
      style: { stroke: 'var(--sam-color-danger)', strokeOpacity: 0.7, strokeDasharray: '4 4' },
    };
  }
  if (DONE.includes(from) && (to === 'running' || to === 'starting'))
    return { data: { active: true, color: '#22c55e' } };
  if (DONE.includes(from) && to === 'needs_you')
    return { data: { active: true, color: '#f59e0b' } };
  if (DONE.includes(from) && DONE.includes(to)) {
    return {
      data: { active: false, color: '#22c55e' },
      style: { stroke: 'var(--sam-color-success)', strokeOpacity: 0.45, strokeDasharray: 'none' },
    };
  }
  return { data: { active: false, color: '#22c55e' } };
}

export function RunGraph({
  run,
  frame,
  selectedKey,
  onSelect,
}: {
  run: RunDef;
  frame: RunFrame;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { nodes, edges, height } = useMemo(() => {
    // Narrow plans read best top-to-bottom at full size; wide fan-outs go left-to-right.
    const widest = Math.max(...layerSteps(run.steps).map((l) => l.length));
    const dir: 'TB' | 'LR' = widest <= 3 ? 'TB' : 'LR';
    const rawNodes: Node[] = run.steps.map((s, i) => ({
      id: s.key,
      type: 'step',
      position: { x: 0, y: 0 },
      data: {
        dir,
        title: s.title,
        number: i + 1,
        status: frame.steps[s.key]?.status ?? 'waiting',
        profile: s.profileId ? (PROFILES[s.profileId]?.name ?? null) : null,
        approval: s.kind === 'approval',
        duration: frame.steps[s.key]?.duration,
        selected: s.key === selectedKey,
      } satisfies StepNodeData,
    }));
    const rawEdges: Edge[] = run.steps.flatMap((s) =>
      s.after.map((a) => {
        const st = edgeStyle(
          frame.steps[a]?.status ?? 'waiting',
          frame.steps[s.key]?.status ?? 'waiting'
        );
        return {
          id: `${a}->${s.key}`,
          source: a,
          target: s.key,
          type: 'flow',
          data: st.data,
          style: st.style,
        };
      })
    );
    const laidOut = applyDagreLayout(rawNodes, rawEdges, {
      direction: dir,
      nodeWidth: NODE_W,
      nodeHeight: NODE_H,
      rankSep: dir === 'TB' ? 40 : 56,
      nodeSep: 24,
    });
    const maxY = Math.max(...laidOut.map((n) => n.position.y)) + NODE_H;
    const minY = Math.min(...laidOut.map((n) => n.position.y));
    return {
      nodes: laidOut,
      edges: rawEdges,
      height: Math.min(780, Math.max(320, maxY - minY + 56)),
    };
  }, [run, frame, selectedKey]);

  return (
    <div
      className="rounded-lg border border-border-default overflow-hidden bg-[color-mix(in_srgb,var(--sam-color-bg-inset)_60%,transparent)]"
      style={{ height }}
      data-testid="run-graph"
      data-intentional-clip
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.4}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => onSelect(n.id)}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            color="var(--sam-color-border-default)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
