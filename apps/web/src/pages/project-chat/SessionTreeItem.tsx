import { ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionItem } from './SessionItem';
import type { SessionTreeNode } from './sessionTree';
import { treeHasMatchingDescendant } from './sessionTree';
import type { TaskInfo } from './useTaskGroups';

/** Beyond this depth, continue nesting but stop adding more visual indent. */
const MAX_VISUAL_DEPTH = 5;
/** Pixels of indent per depth level. */
const INDENT_PX = 10;

/**
 * Recursive renderer for a SessionTreeNode.
 *
 * After the chat-list redesign, retries and forks are promoted to root level
 * with lineage subtitle text. Only genuine agent-dispatched subtasks remain
 * as children. The old 44px chevron gutter and green left rail are removed —
 * children use a subtle indent and a compact inline expand toggle ("▼ 2/3")
 * replaces the progress bar + SUB badge.
 */
export function SessionTreeItem({
  node,
  selectedSessionId,
  onSelect,
  onFork,
  taskInfoMap,
  searchQuery = '',
  defaultExpanded,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork?: (session: ChatSessionResponse) => void;
  taskInfoMap: Map<string, TaskInfo>;
  searchQuery?: string;
  defaultExpanded?: boolean;
}) {
  const hasChildren = node.children.length > 0;

  // Auto-expand when search matches a descendant.
  const hasMatchingDescendant = useMemo(
    () =>
      searchQuery.trim() && hasChildren
        ? treeHasMatchingDescendant(node, searchQuery, taskInfoMap)
        : false,
    [node, searchQuery, taskInfoMap, hasChildren],
  );

  const initialExpanded =
    defaultExpanded !== undefined
      ? defaultExpanded
      : hasMatchingDescendant ||
        node.isContextAnchor ||
        (node.depth === 0 && hasChildren);

  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded);

  const effectiveExpanded = userToggled ? expanded : (hasMatchingDescendant || expanded);

  const childrenId = useId();
  const taskInfo = node.session.taskId ? taskInfoMap.get(node.session.taskId) : undefined;

  // Visual variant
  const variant: 'default' | 'group-parent' | 'group-child' =
    node.depth === 0
      ? hasChildren
        ? 'group-parent'
        : 'default'
      : 'group-child';

  const blockedByTitle = taskInfo?.blocked
    ? getBlockedByTitle(node.session, taskInfoMap)
    : undefined;

  const anchorAriaLabel = node.isContextAnchor
    ? `${node.session.topic || `Chat ${node.session.id.slice(0, 8)}`} — stopped ancestor, click to open`
    : undefined;

  const isSelected = selectedSessionId === node.session.id;

  // Build the compact inline expand toggle badge: "▼ 2/3" or "▸ 2/3"
  const expandToggleBadge = hasChildren ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setUserToggled(true);
        setExpanded(!effectiveExpanded);
      }}
      aria-expanded={effectiveExpanded}
      aria-controls={childrenId}
      aria-label={
        effectiveExpanded
          ? `Hide ${node.totalDescendants} sub-tasks`
          : `Show ${node.totalDescendants} sub-tasks`
      }
      className="inline-flex items-center gap-0.5 bg-transparent border-none cursor-pointer p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sam-color-focus-ring)]"
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--sam-color-fg-muted)',
        whiteSpace: 'nowrap',
      }}
      title={`${node.completedDescendants}/${node.totalDescendants} sub-tasks completed`}
    >
      {effectiveExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      <span style={{ color: node.completedDescendants > 0 ? 'var(--sam-color-success, #22c55e)' : 'var(--sam-color-fg-muted)' }}>
        {node.completedDescendants}/{node.totalDescendants}
      </span>
    </button>
  ) : null;

  // Build badge content
  const badge = (
    <>
      {node.isContextAnchor && (
        <span
          className="inline-flex items-center gap-0.5"
          title="Stopped ancestor — click to open"
          style={{
            fontSize: 10,
            color: '#94a3b8',
            background: 'rgba(148,163,184,0.14)',
            padding: '1px 5px',
            borderRadius: 9999,
            fontWeight: 600,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          <EyeOff size={9} aria-hidden="true" /> Context
        </span>
      )}
      {node.depth >= MAX_VISUAL_DEPTH && (
        <span
          title={`Nested ${node.depth + 1} levels deep`}
          aria-label={`Nesting level ${node.depth + 1}`}
          style={{
            background: 'rgba(245,158,11,0.15)',
            color: '#fbbf24',
            padding: '0 4px',
            borderRadius: 9999,
            fontSize: 10,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          L{node.depth + 1}
        </span>
      )}
      {expandToggleBadge}
    </>
  );

  return (
    <div>
      <div
        style={{
          background: isSelected
            ? 'var(--sam-color-bg-inset, #0d1816)'
            : 'transparent',
          borderBottom:
            node.depth === 0
              ? '1px solid var(--sam-color-border-default, #29423b)'
              : undefined,
        }}
        className={
          isSelected
            ? 'transition-colors'
            : 'transition-colors hover:bg-[var(--sam-color-bg-surface-hover)]'
        }
      >
        <SessionItem
          session={node.session}
          isSelected={isSelected}
          onSelect={onSelect}
          onFork={onFork}
          variant={variant}
          ariaLabel={anchorAriaLabel}
          badge={badge}
          blockedBadge={taskInfo?.blocked}
          blockedByTitle={blockedByTitle}
          lineageText={node.lineageText}
        />
      </div>

      {/* Recursive children — subtle indent, no green rail */}
      {effectiveExpanded && hasChildren && (
        <div
          id={childrenId}
          style={{
            marginLeft:
              node.depth < MAX_VISUAL_DEPTH
                ? INDENT_PX
                : 0,
          }}
        >
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              onSelect={onSelect}
              onFork={onFork}
              taskInfoMap={taskInfoMap}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function getBlockedByTitle(
  session: ChatSessionResponse,
  taskInfoMap: Map<string, TaskInfo>,
): string | undefined {
  if (!session.taskId) return undefined;
  const info = taskInfoMap.get(session.taskId);
  if (!info?.parentTaskId) return undefined;
  const parentInfo = taskInfoMap.get(info.parentTaskId);
  return parentInfo?.title ?? 'parent task';
}
