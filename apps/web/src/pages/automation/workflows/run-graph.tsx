/**
 * The run as a dependency graph: one node per step, an edge for every "after" link, coloured by
 * what is flowing along it. Layout is the Account Map's dagre helper. The direction is the one
 * that keeps nodes largest in the space available (a chain reads top to bottom, a wide fan-out
 * left to right), and the graph is a still picture: no pan or zoom to fight the page scroll. A
 * plan too wide to read at the smallest zoom scrolls sideways instead of shrinking.
 *
 * Loaded lazily (React Flow is large); the Steps list is the accessible equivalent.
 */
import '@xyflow/react/dist/style.css';

import type {
  WorkflowRunDetail,
  WorkflowStepDetail,
  WorkflowStepStatus,
} from '@simple-agent-manager/shared';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import {
  type CSSProperties,
  type FC,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { applyDagreLayout } from '../../../components/account-map/layout/dagre-layout';
import { stagesOf, stepStatusMeta } from './model';
import { StepMark, TONE_COLOR } from './ui';

const NODE_W = 216;
const NODE_H = 76;
const NODE_GAP = 24;
const RANK_GAP = 48;
const PADDING = 16;

type Direction = 'TB' | 'LR';

interface StepNodeData {
  step: WorkflowStepDetail;
  number: number;
  direction: Direction;
  selected: boolean;
  onSelect: (key: string) => void;
  [key: string]: unknown;
}

const StepNode: FC<NodeProps> = ({ data }) => {
  const { step, number, direction, selected, onSelect } = data as unknown as StepNodeData;
  const meta = stepStatusMeta(step);
  return (
    <>
      <Handle
        type="target"
        position={direction === 'TB' ? Position.Top : Position.Left}
        className="!h-2 !w-2 !border-none !bg-[var(--sam-color-border-default)]"
      />
      <button
        type="button"
        data-testid="workflow-graph-node"
        data-step={step.key}
        aria-pressed={selected}
        aria-label={`Step ${number}: ${step.title}. ${meta.label}`}
        onClick={() => onSelect(step.key)}
        className="flex cursor-pointer flex-col gap-1 rounded-lg border border-solid px-3 py-2 text-left"
        style={{
          width: NODE_W,
          height: NODE_H,
          background: 'var(--sam-color-bg-surface)',
          borderColor: selected
            ? 'var(--sam-color-accent-primary)'
            : step.status === 'failed'
              ? 'var(--sam-color-danger-fg)'
              : step.status === 'running' || step.status === 'starting'
                ? 'var(--sam-color-success-fg)'
                : 'var(--sam-color-border-default)',
          boxShadow: selected ? '0 0 0 2px var(--sam-color-accent-primary)' : undefined,
          opacity: step.status === 'waiting' || step.status === 'blocked' ? 0.8 : 1,
        }}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="pt-0.5">
            <StepMark step={step} size={15} />
          </span>
          <span className="line-clamp-2 min-w-0 break-words text-[13px] font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]">
            <span className="mr-1 tabular-nums text-fg-muted">{number}</span>
            {step.title}
          </span>
        </span>
        <span className="mt-auto flex min-w-0 items-center gap-1.5 pl-[23px] text-[11px]">
          <span className="shrink-0 font-semibold" style={{ color: TONE_COLOR[meta.tone] }}>
            {meta.label}
          </span>
          {step.agent?.profileName && (
            <span className="truncate text-fg-muted">· {step.agent.profileName}</span>
          )}
        </span>
      </button>
      <Handle
        type="source"
        position={direction === 'TB' ? Position.Bottom : Position.Right}
        className="!h-2 !w-2 !border-none !bg-[var(--sam-color-border-default)]"
      />
    </>
  );
};

type EdgeTone = 'done' | 'flowing' | 'ready' | 'idle' | 'broken';

const EDGE_STYLE: Record<EdgeTone, CSSProperties> = {
  done: { stroke: 'var(--sam-color-success-fg)', strokeOpacity: 0.5, strokeWidth: 1.5 },
  flowing: { stroke: 'var(--sam-color-success-fg)', strokeWidth: 2.5 },
  ready: { stroke: 'var(--sam-color-success-fg)', strokeOpacity: 0.35, strokeWidth: 1.5 },
  idle: { stroke: 'var(--sam-color-border-default)', strokeWidth: 1.5, strokeDasharray: '4 4' },
  broken: {
    stroke: 'var(--sam-color-danger-fg)',
    strokeOpacity: 0.6,
    strokeWidth: 1.5,
    strokeDasharray: '4 4',
  },
};

/** What an edge says: work flowing now, a finished path, a failure, or nothing yet. */
export function edgeTone(from: WorkflowStepStatus, to: WorkflowStepStatus): EdgeTone {
  if (from === 'failed' || from === 'blocked') return 'broken';
  if (from !== 'completed') return 'idle';
  if (to === 'running' || to === 'starting') return 'flowing';
  return to === 'completed' ? 'done' : 'ready';
}

const StepEdge: FC<EdgeProps> = (props) => {
  const [path] = getBezierPath(props);
  const tone = (props.data?.tone as EdgeTone | undefined) ?? 'idle';
  return <BaseEdge id={props.id} path={path} style={EDGE_STYLE[tone]} />;
};

// Hoisted on purpose: React Flow treats a new object here as new node/edge types and remounts
// every node (rule 64).
const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { step: StepEdge };
/**
 * Smallest zoom the graph is drawn at, so a node stays readable and at least 44 px tall to tap.
 * A graph wider than the space at this zoom scrolls sideways rather than shrinking further.
 */
const MIN_ZOOM = 0.75;

/** Width and height a direction needs at full size. */
function extent(direction: Direction, stages: number, widest: number) {
  const across = widest * NODE_W + (widest - 1) * NODE_GAP;
  const along = stages * NODE_H + (stages - 1) * RANK_GAP;
  const acrossLR = stages * NODE_W + (stages - 1) * RANK_GAP;
  const alongLR = widest * NODE_H + (widest - 1) * NODE_GAP;
  return direction === 'TB'
    ? { width: across + PADDING * 2, height: along + PADDING * 2 }
    : { width: acrossLR + PADDING * 2, height: alongLR + PADDING * 2 };
}

/** The direction that keeps nodes largest in `width`; top to bottom on a tie. */
export function graphDirection(stages: number, widest: number, width: number): Direction {
  const scale = (direction: Direction) =>
    Math.min(1, width / extent(direction, stages, widest).width);
  return scale('LR') > scale('TB') ? 'LR' : 'TB';
}

/** Width steps the layout reacts to; finer changes while resizing do not re-fit the graph. */
const WIDTH_STEP = 8;
const bucket = (width: number) => Math.floor(width / WIDTH_STEP) * WIDTH_STEP;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(bucket(element.clientWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(bucket(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function RunGraph({
  run,
  selectedKey,
  onSelect,
}: {
  run: WorkflowRunDetail;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { ref, width } = useWidth();
  const layout = useMemo(() => {
    const stages = stagesOf(run.steps);
    const widest = Math.max(1, ...stages.map((stage) => stage.length));
    const direction = graphDirection(stages.length, widest, width || 1);
    const status = new Map(run.steps.map((step) => [step.key, step.status]));
    const rawNodes: Node[] = run.steps.map((step, index) => ({
      id: step.key,
      type: 'step',
      position: { x: 0, y: 0 },
      data: {
        step,
        number: index + 1,
        direction,
        selected: step.key === selectedKey,
        onSelect,
      } satisfies StepNodeData,
    }));
    const edges: Edge[] = run.steps.flatMap((step) =>
      step.after
        .filter((key) => status.has(key))
        .map((key) => ({
          id: `${key}->${step.key}`,
          source: key,
          target: step.key,
          type: 'step',
          data: { tone: edgeTone(status.get(key) ?? 'waiting', step.status) },
        }))
    );
    const nodes = applyDagreLayout(rawNodes, edges, {
      direction,
      nodeWidth: NODE_W,
      nodeHeight: NODE_H,
      rankSep: RANK_GAP,
      nodeSep: NODE_GAP,
    });
    const xs = nodes.map((node) => node.position.x);
    const ys = nodes.map((node) => node.position.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const graphWidth = Math.max(...xs) - minX + NODE_W + PADDING * 2;
    const graphHeight = Math.max(...ys) - minY + NODE_H + PADDING * 2;
    const zoom = width ? Math.max(MIN_ZOOM, Math.min(1, width / graphWidth)) : 1;
    const canvasWidth = Math.max(width, Math.ceil(graphWidth * zoom));
    // A graph narrower than the space sits in the middle of it.
    const offsetX = (canvasWidth - graphWidth * zoom) / 2;
    return {
      nodes,
      edges,
      direction,
      canvasWidth,
      canvasHeight: Math.ceil(graphHeight * zoom),
      viewport: { x: offsetX + (PADDING - minX) * zoom, y: (PADDING - minY) * zoom, zoom },
    };
  }, [onSelect, run.steps, selectedKey, width]);

  // When the graph is wider than the space, open it on the selected step, else on its middle,
  // where a fan-out's start, merge and chain are. Only on a new drawing, never on every click.
  const drawn = useRef('');
  const wider = width > 0 && layout.canvasWidth > width;
  useLayoutEffect(() => {
    const element = ref.current;
    const drawing = `${run.id}:${layout.direction}:${width}`;
    if (!element || !wider || drawn.current === drawing) return;
    drawn.current = drawing;
    const { viewport } = layout;
    const target = selectedKey ? layout.nodes.find((node) => node.id === selectedKey) : undefined;
    const centre = target
      ? viewport.x + (target.position.x + NODE_W / 2) * viewport.zoom
      : layout.canvasWidth / 2;
    element.scrollLeft = Math.max(0, centre - element.clientWidth / 2);
  }, [layout, ref, run.id, selectedKey, width, wider]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {wider && (
        <p className="m-0 text-xs text-fg-muted" data-testid="workflow-graph-scroll-hint">
          Wider than the screen: scroll sideways to see every step.
        </p>
      )}
      {/* Scrolls sideways only when the graph is wider than the space at its smallest zoom; it
          is positioned so it contains everything it scrolls (rule 56). */}
      <div
        ref={ref}
        data-testid="workflow-graph"
        data-direction={layout.direction}
        // A graph that scrolls sideways is a tab stop, so arrow keys can scroll it.
        tabIndex={wider ? 0 : undefined}
        role={wider ? 'region' : undefined}
        aria-label={wider ? 'Workflow graph' : undefined}
        className="relative w-full min-w-0 overflow-x-auto overflow-y-hidden rounded-xl border border-solid border-border-default bg-[color-mix(in_srgb,var(--sam-color-bg-inset)_60%,transparent)]"
      >
        {width > 0 && (
          // React Flow clips its own viewport; the canvas is sized to the drawn graph.
          <div
            data-intentional-clip
            style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
          >
            <ReactFlowProvider>
              <ReactFlow
                // Redraw when the space or the direction changes.
                key={`${layout.direction}:${width}`}
                nodes={layout.nodes}
                edges={layout.edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                defaultViewport={layout.viewport}
                minZoom={MIN_ZOOM}
                maxZoom={1}
                panOnDrag={false}
                panOnScroll={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                preventScrolling={false}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  color="var(--sam-color-border-default)"
                />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        )}
      </div>
    </div>
  );
}
