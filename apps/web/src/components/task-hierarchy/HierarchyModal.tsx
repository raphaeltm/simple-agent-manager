import { Dialog } from '@simple-agent-manager/ui';
import { AlertCircle, ArrowLeft, CheckCircle2, CirclePause, Loader2, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatSessionListItem } from '../../lib/api';
import type { TaskInfo } from '../../pages/project-chat/useTaskGroups';
import type { HierarchyNode } from './buildHierarchyTree';
import {
  buildHierarchyTree,
  collectMatchIds,
  containsFocus,
  countNodes,
  filterTree,
  getAncestorPath,
} from './buildHierarchyTree';
import { HierarchyTreeNode } from './HierarchyTreeNode';

// ─── Status helpers ────────────────────────────────────────────────────

const STATUS_ICON_MAP: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2,
  in_progress: Loader2,
  failed: XCircle,
  cancelled: XCircle,
  queued: CirclePause,
  delegated: Loader2,
  ready: CirclePause,
  draft: CirclePause,
};

const STATUS_COLOR_MAP: Record<string, string> = {
  completed: 'var(--sam-color-success)',
  in_progress: 'var(--sam-color-success)',
  failed: 'var(--sam-color-danger)',
  cancelled: 'var(--sam-color-danger)',
  queued: 'var(--sam-color-warning)',
  delegated: 'var(--sam-color-info)',
  ready: 'var(--sam-color-warning)',
  draft: 'var(--sam-color-fg-muted)',
};

const STATUS_LABELS: Record<string, string> = {
  completed: 'completed',
  in_progress: 'running',
  failed: 'failed',
  cancelled: 'cancelled',
  queued: 'queued',
  delegated: 'delegated',
  ready: 'ready',
  draft: 'draft',
};

function getStatusColor(status: string) {
  return STATUS_COLOR_MAP[status] ?? 'var(--sam-color-fg-muted)';
}

// ─── Status summary bar ────────────────────────────────────────────────

function StatusSummaryBar({ tree }: { tree: HierarchyNode }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    function walk(n: HierarchyNode) {
      c[n.task.status] = (c[n.task.status] ?? 0) + 1;
      n.children.forEach(walk);
    }
    walk(tree);
    return c;
  }, [tree]);

  return (
    <div className="flex items-center gap-1.5 flex-wrap" style={{ fontSize: 10 }}>
      {Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => {
          const Icon = STATUS_ICON_MAP[status] ?? AlertCircle;
          const color = getStatusColor(status);
          return (
            <span
              key={status}
              className="flex items-center gap-1"
              style={{ color }}
            >
              <Icon size={10} />
              <span className="font-semibold">{count}</span>
              <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                {STATUS_LABELS[status] ?? status}
              </span>
            </span>
          );
        })}
    </div>
  );
}

// ─── Ancestor breadcrumbs ──────────────────────────────────────────────

function AncestorBreadcrumbs({
  ancestors,
  onNavigate,
}: {
  ancestors: HierarchyNode[];
  onNavigate: (sessionId: string) => void;
}) {
  if (ancestors.length <= 1) return null;

  const display: (HierarchyNode | null)[] =
    ancestors.length <= 4
      ? ancestors.slice(0, -1)
      : [
          ancestors[0]!,
          null,
          ancestors[ancestors.length - 3]!,
          ancestors[ancestors.length - 2]!,
        ];

  return (
    <div
      className="flex flex-wrap items-center gap-0.5 pt-2 pb-1"
      style={{ fontSize: 10, color: 'var(--sam-color-fg-muted)' }}
    >
      <span className="font-semibold uppercase mr-1" style={{ fontSize: 9 }}>
        Path:
      </span>
      {display.map((item, i) => {
        if (item === null) {
          return (
            <span key="ellipsis" style={{ color: 'var(--sam-color-border-default)' }}>
              ...<span className="mx-0.5">/</span>
            </span>
          );
        }
        const color = getStatusColor(item.task.status);
        const hasSession = item.sessionId != null;
        return (
          <span key={item.task.id} className="flex items-center gap-0.5">
            {i > 0 && display[i - 1] !== null && (
              <span style={{ color: 'var(--sam-color-border-default)' }} className="mx-px">
                /
              </span>
            )}
            <button
              type="button"
              onClick={() => hasSession && onNavigate(item.sessionId!)}
              disabled={!hasSession}
              className="rounded px-1 py-px transition-colors duration-150 truncate"
              style={{
                background: 'transparent',
                border: 'none',
                color,
                cursor: hasSession ? 'pointer' : 'default',
                fontSize: 10,
                fontWeight: 500,
                maxWidth: 120,
                opacity: hasSession ? 1 : 0.6,
              }}
              title={item.task.title}
            >
              {item.task.title.slice(0, 25)}
              {item.task.title.length > 25 ? '...' : ''}
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ─── Main modal ────────────────────────────────────────────────────────

export function HierarchyModal({
  isOpen,
  onClose,
  focusTaskId,
  taskInfoMap,
  sessions,
  onNavigate,
}: {
  isOpen: boolean;
  onClose: () => void;
  focusTaskId: string;
  taskInfoMap: Map<string, TaskInfo>;
  sessions: ChatSessionListItem[];
  onNavigate: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [collapseState, setCollapseState] = useState<Map<string, boolean>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  // Build tree from live data
  const treeResult = useMemo(
    () => buildHierarchyTree(taskInfoMap, sessions, focusTaskId),
    [taskInfoMap, sessions, focusTaskId],
  );

  const tree = treeResult?.tree ?? null;

  // Initialize collapse state for new nodes
  useEffect(() => {
    if (!tree) return;
    const newState = new Map(collapseState);
    let changed = false;
    function walk(node: HierarchyNode, depth: number) {
      if (node.children.length > 0 && !newState.has(node.task.id)) {
        const hasFocus = containsFocus(node, focusTaskId);
        newState.set(node.task.id, hasFocus || depth < 2);
        changed = true;
      }
      node.children.forEach((c) => walk(c, depth + 1));
    }
    walk(tree, 0);
    if (changed) setCollapseState(newState);
  }, [tree, focusTaskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isExpanded = useCallback(
    (taskId: string) => collapseState.get(taskId) ?? false,
    [collapseState],
  );

  const toggleExpanded = useCallback(
    (taskId: string) => {
      setCollapseState((prev) => {
        const next = new Map(prev);
        next.set(taskId, !prev.get(taskId));
        return next;
      });
    },
    [],
  );

  // Auto-scroll to focus node on first open
  useEffect(() => {
    if (!isOpen || !tree || hasScrolledRef.current) return;
    const timer = setTimeout(() => {
      const el = scrollRef.current?.querySelector('[data-focus="true"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hasScrolledRef.current = true;
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [isOpen, tree]);

  // Reset scroll guard when modal closes
  useEffect(() => {
    if (!isOpen) hasScrolledRef.current = false;
  }, [isOpen]);

  // Filter
  const displayTree = useMemo(() => {
    if (!tree || !filter.trim()) return tree;
    return filterTree(tree, filter.trim()) ?? tree;
  }, [tree, filter]);

  const filterMatchIds = useMemo(() => {
    if (!tree || !filter.trim()) return null;
    return collectMatchIds(tree, filter.trim());
  }, [tree, filter]);

  const totalNodes = tree ? countNodes(tree) : 0;
  const ancestors = useMemo(
    () => (tree ? getAncestorPath(tree, focusTaskId) : []),
    [tree, focusTaskId],
  );

  if (!tree) return null;

  const stickyHeader = (
    <div
      className="flex-shrink-0"
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--sam-color-border-default)',
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            minHeight: 44,
            minWidth: 44,
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid var(--sam-color-border-default)',
            color: 'var(--sam-color-fg-muted)',
            cursor: 'pointer',
            padding: 0,
          }}
          aria-label="Close hierarchy"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="flex-1">
          <div id="dialog-title" className="text-sm font-semibold" style={{ color: 'var(--sam-color-fg-primary)' }}>
            Task Hierarchy
          </div>
          <div style={{ fontSize: 11, color: 'var(--sam-color-fg-muted)' }}>
            {totalNodes} task{totalNodes !== 1 ? 's' : ''} in this chain
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            minHeight: 44,
            minWidth: 44,
            borderRadius: 6,
            background: 'transparent',
            border: 'none',
            color: 'var(--sam-color-fg-muted)',
            cursor: 'pointer',
            padding: 0,
          }}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {totalNodes > 5 && (
        <div className="mt-2">
          <StatusSummaryBar tree={tree} />
        </div>
      )}

      {ancestors.length > 2 && (
        <AncestorBreadcrumbs ancestors={ancestors} onNavigate={onNavigate} />
      )}

      {totalNodes > 5 && (
        <div className="mt-2">
          <input
            type="text"
            placeholder="Filter tasks..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter tasks"
            className="w-full rounded-md text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--sam-color-accent-primary)]"
            style={{
              padding: '6px 10px',
              background: 'var(--sam-color-bg-inset)',
              border: '1px solid var(--sam-color-border-default)',
              color: 'var(--sam-color-fg-primary)',
            }}
          />
          {filterMatchIds && (
            <div className="mt-1" style={{ fontSize: 10, color: 'var(--sam-color-fg-muted)' }}>
              {filterMatchIds.size} match{filterMatchIds.size !== 1 ? 'es' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="lg" stickyHeader={stickyHeader}>
      <div ref={scrollRef} role="tree" aria-label="Task hierarchy">
        {displayTree && (
          <HierarchyTreeNode
            node={displayTree}
            focusTaskId={focusTaskId}
            onNavigate={onNavigate}
            isExpanded={isExpanded}
            toggleExpanded={toggleExpanded}
            filterMatchIds={filterMatchIds}
          />
        )}
      </div>
    </Dialog>
  );
}
