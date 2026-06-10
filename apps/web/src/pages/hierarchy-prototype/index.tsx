import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CirclePause,
  GitBranch,
  GitMerge,
  ListTodo,
  Loader2,
  MessageSquare,
  Network,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import {
  ALL_SESSIONS,
  ALL_TASKS,
  type MockHierarchyNode,
  type MockSession,
  type MockTask,
  type MockTaskStatus,
  getHierarchyForTask,
} from './mock-data';

// ─── Status helpers ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  completed: { icon: CheckCircle2, color: '#22c55e', label: 'Completed' },
  running: { icon: Loader2, color: '#22c55e', label: 'Running' },
  active: { icon: Loader2, color: '#22c55e', label: 'Running' },
  failed: { icon: XCircle, color: '#ef4444', label: 'Failed' },
  cancelled: { icon: XCircle, color: '#ef4444', label: 'Cancelled' },
  stopped: { icon: CirclePause, color: '#9fb7ae', label: 'Stopped' },
  pending: { icon: CirclePause, color: '#f59e0b', label: 'Pending' },
  queued: { icon: CirclePause, color: '#f59e0b', label: 'Queued' },
  dispatching: { icon: Loader2, color: '#3b82f6', label: 'Dispatching' },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─── Hierarchy type detection ──────────────────────────────────────────

type HierarchyRole = 'parent' | 'child' | 'both' | 'none';

function getHierarchyRole(task: MockTask | null, allTasks: MockTask[]): HierarchyRole {
  if (!task) return 'none';
  const isParent = allTasks.some((t) => t.parentTaskId === task.id);
  const isChild = !!task.parentTaskId;
  if (isParent && isChild) return 'both';
  if (isParent) return 'parent';
  if (isChild) return 'child';
  return 'none';
}

// ─── Hierarchy indicator button ────────────────────────────────────────

function HierarchyIndicator({
  role,
  onClick,
}: {
  role: HierarchyRole;
  onClick: () => void;
}) {
  if (role === 'none') return null;

  const config = {
    parent: { icon: GitBranch, color: '#3b82f6', title: 'Has subtasks' },
    child: { icon: GitMerge, color: '#a78bfa', title: 'Subtask' },
    both: { icon: Network, color: '#f59e0b', title: 'Has parent & subtasks' },
  } as const;

  const { icon: Icon, color, title } = config[role];

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        background: `${color}18`,
        border: `1px solid ${color}40`,
        color,
        cursor: 'pointer',
        padding: 0,
        transition: 'all 150ms',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = `${color}30`;
        (e.currentTarget as HTMLElement).style.borderColor = `${color}70`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = `${color}18`;
        (e.currentTarget as HTMLElement).style.borderColor = `${color}40`;
      }}
    >
      <Icon size={11} />
    </button>
  );
}

// ─── Session list item ─────────────────────────────────────────────────

function SessionListItem({
  session,
  task,
  isSelected,
  onSelect,
  onShowHierarchy,
  allTasks,
}: {
  session: MockSession;
  task: MockTask | null;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onShowHierarchy: (taskId: string) => void;
  allTasks: MockTask[];
}) {
  const statusCfg = getStatusConfig(session.status);
  const StatusIcon = statusCfg.icon;
  const ModeIcon = task?.taskMode === 'task' ? ListTodo : MessageSquare;
  const mode = task?.taskMode === 'task' ? 'Task' : 'Chat';
  const hierarchyRole = getHierarchyRole(task, allTasks);

  return (
    <div
      style={{
        borderBottom: '1px solid rgba(34,197,94,0.06)',
        borderLeft: isSelected ? '3px solid #22c55e' : '3px solid transparent',
        background: isSelected ? 'rgba(22,163,74,0.08)' : undefined,
        padding: '8px 12px',
        cursor: 'pointer',
        transition: 'all 150ms',
      }}
      onClick={() => onSelect(session.id)}
      onMouseEnter={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLElement).style.background = 'rgba(34,197,94,0.04)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected)
          (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ color: statusCfg.color, display: 'flex', flexShrink: 0 }}>
          <StatusIcon
            size={14}
            className={session.status === 'active' || session.status === 'running' ? 'motion-safe:animate-spin' : ''}
          />
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: isSelected ? 600 : 500,
            color: '#e2e8f0',
          }}
        >
          {session.topic ?? `Chat ${session.id.slice(0, 8)}`}
        </span>
      </div>
      {/* Subtitle row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 20,
          fontSize: 10,
          color: '#9fb7ae',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
          <ModeIcon size={10} />
          <span>{mode}</span>
        </span>
        <HierarchyIndicator
          role={hierarchyRole}
          onClick={() => task && onShowHierarchy(task.id)}
        />
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
          {formatRelative(session.startedAt)}
        </span>
      </div>
    </div>
  );
}

// ─── Flat node card (used in both ancestor trail and child list) ───────

function NodeCard({
  node,
  isFocus,
  onNavigate,
  compact,
  depthBadge,
  isFilterMatch,
}: {
  node: MockHierarchyNode;
  isFocus: boolean;
  onNavigate: (sessionId: string) => void;
  compact?: boolean;
  depthBadge?: number;
  isFilterMatch?: boolean;
}) {
  const statusCfg = getStatusConfig(node.task.status);
  const StatusIcon = statusCfg.icon;

  const matchHighlight = isFilterMatch && !isFocus;
  const defaultBg = matchHighlight ? 'rgba(59,130,246,0.10)' : '#0d1816';
  const defaultBorder = matchHighlight ? '#3b82f680' : '#29423b';

  return (
    <button
      type="button"
      data-focus={isFocus ? 'true' : undefined}
      onClick={() => onNavigate(node.session.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: compact ? '6px 10px' : '8px 12px',
        borderRadius: 8,
        border: isFocus ? '2px solid #22c55e' : `1px solid ${defaultBorder}`,
        background: isFocus ? 'rgba(22,163,74,0.12)' : defaultBg,
        color: '#e2e8f0',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 150ms',
        boxShadow: isFocus ? '0 0 12px rgba(34,197,94,0.15)' : matchHighlight ? '0 0 8px rgba(59,130,246,0.1)' : undefined,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!isFocus) {
          (e.currentTarget as HTMLElement).style.borderColor = '#22c55e60';
          (e.currentTarget as HTMLElement).style.background = 'rgba(22,163,74,0.06)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isFocus) {
          (e.currentTarget as HTMLElement).style.borderColor = defaultBorder;
          (e.currentTarget as HTMLElement).style.background = defaultBg;
        }
      }}
    >
      <span style={{ color: statusCfg.color, display: 'flex', flexShrink: 0 }}>
        <StatusIcon
          size={compact ? 14 : 16}
          className={node.task.status === 'running' ? 'motion-safe:animate-spin' : ''}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 11 : 12,
            fontWeight: isFocus ? 600 : 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.task.title}
        </div>
        <div
          style={{
            fontSize: compact ? 9 : 10,
            color: '#9fb7ae',
            marginTop: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              padding: '0 4px',
              borderRadius: 9999,
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase',
              background: `${statusCfg.color}20`,
              color: statusCfg.color,
            }}
          >
            {statusCfg.label}
          </span>
          {node.task.blocked && (
            <span
              style={{
                display: 'inline-block',
                padding: '0 4px',
                borderRadius: 9999,
                fontSize: 9,
                fontWeight: 600,
                textTransform: 'uppercase',
                background: '#ef444420',
                color: '#ef4444',
              }}
            >
              BLOCKED
            </span>
          )}
          <span>{formatRelative(node.session.startedAt)}</span>
        </div>
      </div>
      {depthBadge != null && depthBadge > 0 && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            padding: '1px 5px',
            borderRadius: 9999,
            background: 'rgba(148,163,184,0.15)',
            color: '#94a3b8',
            flexShrink: 0,
          }}
        >
          L{depthBadge + 1}
        </span>
      )}
      {isFocus && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: '#22c55e',
            letterSpacing: '0.05em',
            flexShrink: 0,
          }}
        >
          YOU
        </span>
      )}
    </button>
  );
}

// ─── Tree connector (SVG curved lines) ──────────────────────────────────

/** Width of the connector column in px. */
const CONNECTOR_W = 16;
/** Radius of the quarter-circle curve connecting vertical trunk to horizontal branch. */
const CURVE_R = 6;
/** Stroke width for all connector lines. */
const LINE_W = 1.5;
/** X position of the vertical trunk line center. */
const TRUNK_X = 1;
/** Opaque color for connector lines — no transparency avoids bright overlap artifacts. */
const LINE_CLR = '#3d6e5c';
/** Gap between sibling nodes (applied as paddingBottom so connectors span it). */
const SIBLING_GAP = 2;

/**
 * SVG connector column drawn to the left of each child node.
 * Stretches the full height of the child (including its sub-tree) via alignSelf: stretch.
 *
 * Uses a single <path> per visual segment to avoid transparent overlap artifacts.
 * The `branchY` prop controls where the horizontal branch meets the node's vertical center.
 */
function TreeConnector({ isLast, branchY }: { isLast: boolean; branchY: number }) {
  // Curve + horizontal branch (always drawn).
  const curvePath = [
    `M${TRUNK_X},${branchY - CURVE_R}`,
    `Q${TRUNK_X},${branchY} ${TRUNK_X + CURVE_R},${branchY}`,
    `H${CONNECTOR_W}`,
  ].join(' ');

  return (
    <div
      style={{
        width: CONNECTOR_W,
        flexShrink: 0,
        alignSelf: 'stretch',
        position: 'relative',
        minHeight: branchY + 4,
      }}
    >
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: CONNECTOR_W,
          height: '100%',
          overflow: 'visible',
        }}
      >
        {/* Vertical trunk — one unbroken line avoids join artifacts */}
        <line
          x1={TRUNK_X}
          y1={0}
          x2={TRUNK_X}
          y2={isLast ? branchY - CURVE_R : '100%'}
          stroke={LINE_CLR}
          strokeWidth={LINE_W}
        />
        {/* Curve + horizontal branch */}
        <path d={curvePath} fill="none" stroke={LINE_CLR} strokeWidth={LINE_W} />
      </svg>
    </div>
  );
}

// ─── Collapsible children group ────────────────────────────────────────

const INITIALLY_VISIBLE = 5;

function ChildrenGroup({
  children,
  focusTaskId,
  onNavigate,
  depth,
  filterMatchIds = null,
}: {
  children: MockHierarchyNode[];
  focusTaskId: string;
  onNavigate: (sessionId: string) => void;
  depth: number;
  filterMatchIds?: Set<string> | null;
}) {
  const needsCollapse = children.length > INITIALLY_VISIBLE + 2;
  const [expanded, setExpanded] = useState(!needsCollapse);

  const visibleChildren = useMemo(() => {
    if (expanded) return children;
    const first = children.slice(0, INITIALLY_VISIBLE);
    const firstIds = new Set(first.map((c) => c.task.id));
    const extra = children.slice(INITIALLY_VISIBLE).filter((c) => containsFocus(c, focusTaskId));
    return [...first, ...extra.filter((c) => !firstIds.has(c.task.id))];
  }, [children, expanded, focusTaskId]);

  const hiddenCount = expanded ? 0 : children.length - visibleChildren.length;
  const hasMore = !expanded && hiddenCount > 0;

  const statusSummary = useMemo(() => {
    if (expanded || hiddenCount === 0) return null;
    const visibleIds = new Set(visibleChildren.map((c) => c.task.id));
    const hidden = children.filter((c) => !visibleIds.has(c.task.id));
    const counts: Record<string, number> = {};
    for (const c of hidden) {
      const s = c.task.status;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [children, visibleChildren, expanded, hiddenCount]);

  const showConnectors = depth <= MAX_INDENT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {visibleChildren.map((child, i) => {
        const isLastVisible = i === visibleChildren.length - 1;
        const isLast = isLastVisible && !hasMore;
        return (
          <GraphNodeFlat
            key={child.task.id}
            node={child}
            focusTaskId={focusTaskId}
            onNavigate={onNavigate}
            depth={depth}
            isLast={isLast}
            filterMatchIds={filterMatchIds}
          />
        );
      })}
      {hasMore && (
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          {showConnectors && <TreeConnector isLast branchY={14} />}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px dashed #29423b',
              background: 'transparent',
              color: '#9fb7ae',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
              transition: 'all 150ms',
              flex: 1,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = '#22c55e60';
              (e.currentTarget as HTMLElement).style.color = '#e2e8f0';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = '#29423b';
              (e.currentTarget as HTMLElement).style.color = '#9fb7ae';
            }}
          >
            <ChevronDown size={12} />
            <span>Show {hiddenCount} more</span>
            {statusSummary && (
              <span style={{ display: 'flex', gap: 3, marginLeft: 4 }}>
                {Object.entries(statusSummary).map(([status, count]) => {
                  const cfg = getStatusConfig(status);
                  return (
                    <span
                      key={status}
                      style={{
                        fontSize: 9,
                        padding: '0 4px',
                        borderRadius: 9999,
                        background: `${cfg.color}20`,
                        color: cfg.color,
                        fontWeight: 600,
                      }}
                    >
                      {count}
                    </span>
                  );
                })}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Graph node with SVG tree connectors ────────────────────────────────

/** Max connector depth levels. Beyond this we show depth badge instead. */
const MAX_INDENT = 5;

function GraphNodeFlat({
  node,
  focusTaskId,
  onNavigate,
  depth = 0,
  isLast = true,
  filterMatchIds = null,
}: {
  node: MockHierarchyNode;
  focusTaskId: string;
  onNavigate: (sessionId: string) => void;
  depth?: number;
  isLast?: boolean;
  filterMatchIds?: Set<string> | null;
}) {
  const isFocus = node.task.id === focusTaskId;
  const hasChildren = node.children.length > 0;

  const hasFocusDescendant = hasChildren && containsFocus(node, focusTaskId);
  const hasFilterDescendant =
    hasChildren && filterMatchIds != null && hasMatchingDescendant(node, filterMatchIds);
  const [childrenVisible, setChildrenVisible] = useState(
    hasChildren && (hasFocusDescendant || depth < 2),
  );

  // Force-open branches that contain filter matches
  const forceOpen = hasFilterDescendant && !childrenVisible;
  const effectiveChildrenVisible = childrenVisible || forceOpen;

  const showConnector = depth > 0 && depth <= MAX_INDENT;
  const showDepthBadge = depth > MAX_INDENT;
  const compact = depth > 1;

  // Measure actual node row height so the connector branch hits dead-center.
  const nodeRowRef = useRef<HTMLDivElement>(null);
  const [branchY, setBranchY] = useState(compact ? 23 : 26);
  useLayoutEffect(() => {
    if (nodeRowRef.current) {
      setBranchY(nodeRowRef.current.offsetHeight / 2);
    }
  }, []);

  return (
    <div style={{ display: 'flex', paddingBottom: isLast ? 0 : SIBLING_GAP }}>
      {/* SVG connector column — stretches full height including sub-tree */}
      {showConnector && <TreeConnector isLast={isLast} branchY={branchY} />}

      {/* Content column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Node row: expand toggle + card */}
        <div ref={nodeRowRef} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {hasChildren && (
            <button
              type="button"
              onClick={() => setChildrenVisible(!childrenVisible)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: '#9fb7ae',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
              }}
            >
              {effectiveChildrenVisible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <NodeCard
              node={node}
              isFocus={isFocus}
              onNavigate={onNavigate}
              compact={compact}
              depthBadge={showDepthBadge ? depth : undefined}
              isFilterMatch={filterMatchIds?.has(node.task.id) ?? false}
            />
          </div>
        </div>

        {/* Children — offset to align trunk under the expand toggle */}
        {effectiveChildrenVisible && hasChildren && (
          <div style={{ marginLeft: 10 }}>
            <ChildrenGroup
              children={node.children}
              focusTaskId={focusTaskId}
              onNavigate={onNavigate}
              depth={depth + 1}
              filterMatchIds={filterMatchIds}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function containsFocus(node: MockHierarchyNode, focusTaskId: string): boolean {
  if (node.task.id === focusTaskId) return true;
  return node.children.some((c) => containsFocus(c, focusTaskId));
}

function hasMatchingDescendant(node: MockHierarchyNode, matchIds: Set<string>): boolean {
  for (const child of node.children) {
    if (matchIds.has(child.task.id) || hasMatchingDescendant(child, matchIds)) return true;
  }
  return false;
}

function countNodes(n: MockHierarchyNode): number {
  return 1 + n.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/** Walk from the focus node up to root, returning the ancestor path. */
function getAncestorPath(
  tree: MockHierarchyNode,
  focusTaskId: string,
): MockHierarchyNode[] {
  const path: MockHierarchyNode[] = [];
  function walk(node: MockHierarchyNode): boolean {
    if (node.task.id === focusTaskId) {
      path.push(node);
      return true;
    }
    for (const child of node.children) {
      if (walk(child)) {
        path.push(node);
        return true;
      }
    }
    return false;
  }
  walk(tree);
  return path.reverse(); // root first
}

// ─── Breadcrumb trail for deep hierarchies ─────────────────────────────

function AncestorBreadcrumbs({
  ancestors,
  onNavigate,
}: {
  ancestors: MockHierarchyNode[];
  onNavigate: (sessionId: string) => void;
}) {
  if (ancestors.length <= 1) return null;

  // Show up to 3 ancestors, with ellipsis if more
  const display =
    ancestors.length <= 4
      ? ancestors.slice(0, -1) // all except the focus node
      : [
          ancestors[0],
          null, // ellipsis marker
          ancestors[ancestors.length - 3],
          ancestors[ancestors.length - 2],
        ];

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        padding: '8px 0 4px',
        fontSize: 10,
        color: '#9fb7ae',
      }}
    >
      <span style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 9, marginRight: 4 }}>
        Path:
      </span>
      {display.map((item, i) => {
        if (item === null) {
          return (
            <span key="ellipsis" style={{ color: '#586e66' }}>
              ...
              <span style={{ margin: '0 2px' }}>/</span>
            </span>
          );
        }
        const cfg = getStatusConfig(item.task.status);
        return (
          <span key={item.task.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {i > 0 && display[i - 1] !== null && (
              <span style={{ color: '#586e66', margin: '0 1px' }}>/</span>
            )}
            <button
              type="button"
              onClick={() => onNavigate(item.session.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: cfg.color,
                cursor: 'pointer',
                padding: '1px 4px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: 500,
                maxWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-block',
                transition: 'background 150ms',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(34,197,94,0.1)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
              title={item.task.title}
            >
              {item.task.title.slice(0, 25)}{item.task.title.length > 25 ? '...' : ''}
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ─── Status summary bar ────────────────────────────────────────────────

function StatusSummaryBar({ tree }: { tree: MockHierarchyNode }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    function walk(n: MockHierarchyNode) {
      const s = n.task.status;
      c[s] = (c[s] ?? 0) + 1;
      n.children.forEach(walk);
    }
    walk(tree);
    return c;
  }, [tree]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        fontSize: 10,
      }}
    >
      {Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => {
          const cfg = getStatusConfig(status);
          return (
            <span
              key={status}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                color: cfg.color,
              }}
            >
              <cfg.icon size={10} />
              <span style={{ fontWeight: 600 }}>{count}</span>
              <span style={{ color: '#9fb7ae' }}>{cfg.label.toLowerCase()}</span>
            </span>
          );
        })}
    </div>
  );
}

// ─── Hierarchy modal ───────────────────────────────────────────────────

function nodeMatchesQuery(node: MockHierarchyNode, q: string): boolean {
  const label = getStatusConfig(node.task.status).label.toLowerCase();
  return (
    node.task.title.toLowerCase().includes(q) ||
    label.includes(q) ||
    node.task.status.toLowerCase().includes(q) ||
    (node.task.blocked && 'blocked'.includes(q))
  );
}

function filterTree(node: MockHierarchyNode, query: string): MockHierarchyNode | null {
  const q = query.toLowerCase();
  const selfMatch = nodeMatchesQuery(node, q);
  const filteredChildren: MockHierarchyNode[] = [];
  for (const child of node.children) {
    const fc = filterTree(child, query);
    if (fc) filteredChildren.push(fc);
  }
  if (selfMatch || filteredChildren.length > 0) {
    return { ...node, children: selfMatch ? node.children : filteredChildren };
  }
  return null;
}

/** Collect IDs of all nodes that directly match the query (not just ancestors kept for context). */
function collectMatchIds(node: MockHierarchyNode, query: string): Set<string> {
  const q = query.toLowerCase();
  const ids = new Set<string>();
  function walk(n: MockHierarchyNode) {
    if (nodeMatchesQuery(n, q)) ids.add(n.task.id);
    n.children.forEach(walk);
  }
  walk(node);
  return ids;
}

function HierarchyModal({
  tree,
  focusTaskId,
  onClose,
  onNavigate,
}: {
  tree: MockHierarchyNode;
  focusTaskId: string;
  onClose: () => void;
  onNavigate: (sessionId: string) => void;
}) {
  const totalNodes = countNodes(tree);
  const ancestors = useMemo(() => getAncestorPath(tree, focusTaskId), [tree, focusTaskId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');

  const displayTree = useMemo(() => {
    if (!filter.trim()) return tree;
    return filterTree(tree, filter.trim()) ?? tree;
  }, [tree, filter]);

  const filterMatchIds = useMemo(() => {
    if (!filter.trim()) return null;
    return collectMatchIds(tree, filter.trim());
  }, [tree, filter]);

  // Auto-scroll to the focused node after mount
  useEffect(() => {
    const timer = setTimeout(() => {
      const el = scrollRef.current?.querySelector('[data-focus="true"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [focusTaskId]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      {/* Backdrop */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 540,
          maxHeight: 'calc(100dvh - 2rem)',
          background: '#111c19',
          borderRadius: 12,
          border: '1px solid #29423b',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #29423b',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'transparent',
                border: '1px solid #29423b',
                color: '#9fb7ae',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <ArrowLeft size={14} />
            </button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
                Task Hierarchy
              </div>
              <div style={{ fontSize: 11, color: '#9fb7ae' }}>
                {totalNodes} task{totalNodes !== 1 ? 's' : ''} in this chain
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                color: '#9fb7ae',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>

          {/* Status summary */}
          {totalNodes > 5 && (
            <div style={{ marginTop: 8 }}>
              <StatusSummaryBar tree={tree} />
            </div>
          )}

          {/* Breadcrumb path for deep hierarchies */}
          {ancestors.length > 2 && (
            <AncestorBreadcrumbs ancestors={ancestors} onNavigate={onNavigate} />
          )}

          {/* Filter input */}
          {totalNodes > 5 && (
            <div style={{ marginTop: 8 }}>
              <input
                type="text"
                placeholder="Filter tasks…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: 12,
                  background: '#0a1210',
                  border: '1px solid #29423b',
                  borderRadius: 6,
                  color: '#e2e8f0',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
        </div>

        {/* Graph content */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: 12,
          }}
        >
          <GraphNodeFlat
            node={displayTree}
            focusTaskId={focusTaskId}
            onNavigate={onNavigate}
            filterMatchIds={filterMatchIds}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main prototype page ───────────────────────────────────────────────

export function HierarchyPrototype() {
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    ALL_SESSIONS[0]?.id ?? null,
  );

  const hashTaskId = location.hash.startsWith('#hierarchy-')
    ? location.hash.slice('#hierarchy-'.length)
    : null;

  const taskMap = useMemo(() => new Map(ALL_TASKS.map((t) => [t.id, t])), []);

  const openHierarchy = useCallback(
    (taskId: string) => {
      navigate(`${location.pathname}#hierarchy-${taskId}`, { replace: false });
    },
    [navigate, location.pathname],
  );

  const closeHierarchy = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const hierarchyData = useMemo(() => {
    if (!hashTaskId) return null;
    return getHierarchyForTask(hashTaskId, ALL_TASKS, ALL_SESSIONS);
  }, [hashTaskId]);

  const handleNavigateFromGraph = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      navigate(-1);
    },
    [navigate],
  );

  return (
    <div style={{ height: '100vh', overflow: 'auto', background: '#0a1210' }}>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>

      {/* Top bar */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: '#111c19',
          borderBottom: '1px solid #29423b',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Network size={18} style={{ color: '#22c55e' }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>
            Task Hierarchy Prototype
          </div>
          <div style={{ fontSize: 11, color: '#9fb7ae' }}>
            Tap the hierarchy icon next to Task/Chat to see the tree
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          padding: '10px 16px',
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          fontSize: 11,
          color: '#9fb7ae',
          borderBottom: '1px solid rgba(34,197,94,0.06)',
        }}
      >
        {([
          { icon: GitBranch, color: '#3b82f6', label: 'Parent' },
          { icon: GitMerge, color: '#a78bfa', label: 'Child' },
          { icon: Network, color: '#f59e0b', label: 'Both' },
          { icon: MessageSquare, color: '#9fb7ae', label: 'No hierarchy' },
        ] as const).map(({ icon: Icon, color, label }) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: `${color}18`,
                border: `1px solid ${color}40`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color,
              }}
            >
              <Icon size={9} />
            </span>
            {label}
          </span>
        ))}
      </div>

      {/* Session list */}
      <div>
        {ALL_SESSIONS.map((session) => {
          const task = session.taskId ? taskMap.get(session.taskId) ?? null : null;
          return (
            <SessionListItem
              key={session.id}
              session={session}
              task={task}
              isSelected={selectedSessionId === session.id}
              onSelect={setSelectedSessionId}
              onShowHierarchy={openHierarchy}
              allTasks={ALL_TASKS}
            />
          );
        })}
      </div>

      {/* Hierarchy modal */}
      {hierarchyData && (
        <HierarchyModal
          tree={hierarchyData.tree}
          focusTaskId={hierarchyData.focusTaskId}
          onClose={closeHierarchy}
          onNavigate={handleNavigateFromGraph}
        />
      )}
    </div>
  );
}
