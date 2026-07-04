import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { HierarchyNode } from './buildHierarchyTree';
import { containsFocus } from './buildHierarchyTree';
import { CHEVRON_SIZE, HierarchyTreeNode } from './HierarchyTreeNode';
import { getStatusColorVar, statusBadgeStyle } from './statusConfig';
import { TreeConnector } from './TreeConnector';

/** Max children shown before collapsing into "Show N more". */
const INITIALLY_VISIBLE = 5;

/** Max connector depth — beyond this, show depth badge instead of connector. */
export const MAX_INDENT = 5;

export function HierarchyChildrenGroup({
  nodes,
  focusTaskId,
  onNavigate,
  depth,
  filterMatchIds,
  isExpanded,
  toggleExpanded,
}: {
  nodes: HierarchyNode[];
  focusTaskId: string;
  onNavigate: (sessionId: string) => void;
  depth: number;
  filterMatchIds: Set<string> | null;
  isExpanded: (taskId: string) => boolean;
  toggleExpanded: (taskId: string) => void;
}) {
  const needsCollapse = nodes.length > INITIALLY_VISIBLE + 2;
  const [showAll, setShowAll] = useState(!needsCollapse);

  const visibleChildren = useMemo(() => {
    if (showAll) return nodes;
    const first = nodes.slice(0, INITIALLY_VISIBLE);
    const firstIds = new Set(first.map((c) => c.task.id));
    const extra = nodes
      .slice(INITIALLY_VISIBLE)
      .filter((c) => containsFocus(c, focusTaskId));
    return [...first, ...extra.filter((c) => !firstIds.has(c.task.id))];
  }, [nodes, showAll, focusTaskId]);

  const hiddenCount = showAll ? 0 : nodes.length - visibleChildren.length;
  const hasMore = !showAll && hiddenCount > 0;

  const statusSummary = useMemo(() => {
    if (showAll || hiddenCount === 0) return null;
    const visibleIds = new Set(visibleChildren.map((c) => c.task.id));
    const hidden = nodes.filter((c) => !visibleIds.has(c.task.id));
    const counts: Record<string, number> = {};
    for (const c of hidden) {
      counts[c.task.status] = (counts[c.task.status] ?? 0) + 1;
    }
    return counts;
  }, [nodes, visibleChildren, showAll, hiddenCount]);

  const showConnectors = depth <= MAX_INDENT;

  return (
    <div className="flex flex-col" role="group">
      {visibleChildren.map((child, i) => {
        const isLastVisible = i === visibleChildren.length - 1;
        const isLast = isLastVisible && !hasMore;
        return (
          <HierarchyTreeNode
            key={child.task.id}
            node={child}
            focusTaskId={focusTaskId}
            onNavigate={onNavigate}
            depth={depth}
            isLast={isLast}
            filterMatchIds={filterMatchIds}
            isExpanded={isExpanded}
            toggleExpanded={toggleExpanded}
          />
        );
      })}
      {hasMore && (
        <div className="flex items-start">
          {showConnectors && <TreeConnector isLast branchY={14} />}
          {/* Align with sibling cards, which sit after the chevron/spacer + 4px gap */}
          <div style={{ width: CHEVRON_SIZE + 4, flexShrink: 0 }} aria-hidden="true" />
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 flex-1"
            style={{
              border: '1px dashed var(--sam-color-border-default)',
              background: 'transparent',
              color: 'var(--sam-color-fg-muted)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--sam-color-accent-primary)';
              e.currentTarget.style.color = 'var(--sam-color-fg-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--sam-color-border-default)';
              e.currentTarget.style.color = 'var(--sam-color-fg-muted)';
            }}
          >
            <ChevronDown size={12} />
            <span>Show {hiddenCount} more</span>
            {statusSummary && (
              <span className="flex gap-0.5 ml-1">
                {Object.entries(statusSummary).map(([status, count]) => (
                  <span
                    key={status}
                    className="rounded-full font-semibold"
                    style={statusBadgeStyle(getStatusColorVar(status))}
                  >
                    {count}
                  </span>
                ))}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
