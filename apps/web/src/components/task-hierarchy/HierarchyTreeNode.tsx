import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { HierarchyNode } from './buildHierarchyTree';
import { hasMatchingDescendant } from './buildHierarchyTree';
import { HierarchyChildrenGroup, MAX_INDENT } from './HierarchyChildrenGroup';
import { HierarchyNodeCard } from './HierarchyNodeCard';
import { TreeConnector } from './TreeConnector';

/** Gap between sibling nodes in px. */
const SIBLING_GAP = 2;

export function HierarchyTreeNode({
  node,
  focusTaskId,
  onNavigate,
  depth = 0,
  isLast = true,
  filterMatchIds = null,
  isExpanded,
  toggleExpanded,
}: {
  node: HierarchyNode;
  focusTaskId: string;
  onNavigate: (sessionId: string) => void;
  depth?: number;
  isLast?: boolean;
  filterMatchIds?: Set<string> | null;
  isExpanded: (taskId: string) => boolean;
  toggleExpanded: (taskId: string) => void;
}) {
  const isFocus = node.task.id === focusTaskId;
  const hasChildren = node.children.length > 0;

  const childrenVisible = isExpanded(node.task.id);
  const hasFilterDescendant =
    hasChildren && filterMatchIds != null && hasMatchingDescendant(node, filterMatchIds);
  const effectiveChildrenVisible = childrenVisible || hasFilterDescendant;

  const showConnector = depth > 0 && depth <= MAX_INDENT;
  const showDepthBadge = depth > MAX_INDENT;
  const compact = depth > 1;

  const nodeRowRef = useRef<HTMLDivElement>(null);
  const [branchY, setBranchY] = useState(compact ? 23 : 26);
  useLayoutEffect(() => {
    if (nodeRowRef.current) {
      setBranchY(nodeRowRef.current.offsetHeight / 2);
    }
  }, []);

  return (
    <div className="flex" style={{ paddingBottom: isLast ? 0 : SIBLING_GAP }}>
      {showConnector && <TreeConnector isLast={isLast} branchY={branchY} />}
      <div className="flex-1 min-w-0">
        <div ref={nodeRowRef} className="flex items-center gap-1">
          {hasChildren && (
            <button
              type="button"
              onClick={() => toggleExpanded(node.task.id)}
              className="flex items-center justify-center shrink-0"
              style={{
                width: 20,
                height: 20,
                minWidth: 44,
                minHeight: 44,
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: 'var(--sam-color-fg-muted)',
                cursor: 'pointer',
                padding: 0,
              }}
              aria-label={effectiveChildrenVisible ? 'Collapse subtasks' : 'Expand subtasks'}
              aria-expanded={effectiveChildrenVisible}
            >
              {effectiveChildrenVisible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          <div className="flex-1 min-w-0">
            <HierarchyNodeCard
              node={node}
              isFocus={isFocus}
              onNavigate={onNavigate}
              compact={compact}
              depthBadge={showDepthBadge ? depth : undefined}
              isFilterMatch={filterMatchIds?.has(node.task.id) ?? false}
              ariaExpanded={hasChildren ? effectiveChildrenVisible : undefined}
            />
          </div>
        </div>

        {effectiveChildrenVisible && hasChildren && (
          <div style={{ marginLeft: 10 }}>
            <HierarchyChildrenGroup
              nodes={node.children}
              focusTaskId={focusTaskId}
              onNavigate={onNavigate}
              depth={depth + 1}
              filterMatchIds={filterMatchIds}
              isExpanded={isExpanded}
              toggleExpanded={toggleExpanded}
            />
          </div>
        )}
      </div>
    </div>
  );
}
