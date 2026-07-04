import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { HierarchyNode } from './buildHierarchyTree';
import { hasMatchingDescendant } from './buildHierarchyTree';
import { HierarchyChildrenGroup, MAX_INDENT } from './HierarchyChildrenGroup';
import { HierarchyNodeCard } from './HierarchyNodeCard';
import { iconButtonStyle } from './statusConfig';
import { TreeConnector } from './TreeConnector';

/** Gap between sibling nodes in px. */
const SIBLING_GAP = 2;

/** Diameter of the circular expand/collapse chevron button (and leaf spacer). */
export const CHEVRON_SIZE = 20;

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
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleExpanded(node.task.id)}
              className="flex items-center justify-center shrink-0"
              style={{
                ...iconButtonStyle,
                // Neutralize iconButtonStyle's 44px min sizing — without this the
                // chevron renders 44x44 and pushes parent cards right of their children.
                width: CHEVRON_SIZE,
                height: CHEVRON_SIZE,
                minWidth: CHEVRON_SIZE,
                minHeight: CHEVRON_SIZE,
                borderRadius: '50%',
                border: '1px solid var(--sam-color-border-default)',
                background: 'var(--sam-color-bg-inset)',
              }}
              aria-label={effectiveChildrenVisible ? 'Collapse subtasks' : 'Expand subtasks'}
              aria-expanded={effectiveChildrenVisible}
            >
              {effectiveChildrenVisible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            // Spacer keeps leaf cards aligned with expandable siblings' cards.
            <div style={{ width: CHEVRON_SIZE, flexShrink: 0 }} aria-hidden="true" />
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
