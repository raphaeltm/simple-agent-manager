import { ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionItem } from './SessionItem';
import type { SessionTreeNode } from './sessionTree';
import { treeHasMatchingDescendant } from './sessionTree';
import { SubTaskProgressBar } from './SubTaskProgressBar';
import type { TaskInfo } from './useTaskGroups';

/** Pixels of indent per depth level. */
const INDENT_PX = 10;
/** Beyond this depth, continue nesting but stop adding more visual indent. */
const MAX_VISUAL_DEPTH = 5;

/**
 * Recursive renderer for a SessionTreeNode. Each level of children is
 * visually enclosed by a left rail (green, dimmed), matching the legacy
 * TaskGroup visual language. Context-anchor rows (ancestors lifted in from
 * stale data) are rendered with reduced opacity and labeled as such for
 * assistive tech.
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
  /** Override default expand state (e.g., force expanded when searching). */
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

  // Default expanded for top-level parent groups, context anchors, and when a
  // descendant matches the current search. Deep levels collapsed by default.
  const initialExpanded =
    defaultExpanded ??
    hasMatchingDescendant ??
    node.isContextAnchor ??
    (node.depth === 0 && hasChildren);

  const [userToggled, setUserToggled] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded);

  // When search surfaces a match and the user hasn't explicitly toggled, open.
  const effectiveExpanded = userToggled ? expanded : (hasMatchingDescendant || expanded);

  const childrenId = useId();
  const taskInfo = node.session.taskId ? taskInfoMap.get(node.session.taskId) : undefined;
  const ideaTitle = taskInfo?.title;

  // Visual variant: the tree uses "group-parent" at depth 0 with children,
  // "group-child" for any deeper node, and plain "default" only for depth-0
  // leaves.
  const variant: 'default' | 'group-parent' | 'group-child' =
    node.depth === 0
      ? hasChildren
        ? 'group-parent'
        : 'default'
      : 'group-child';

  const blockedByTitle = taskInfo?.blocked
    ? getBlockedByTitle(node.session, taskInfoMap)
    : undefined;

  const anchorLabel = node.isContextAnchor ? ' — context only (stale)' : '';

  return (
    <div
      style={{
        // Context anchors dim to signal they're stale pass-through context.
        opacity: node.isContextAnchor ? 0.55 : 1,
      }}
    >
      <div
        aria-label={
          node.isContextAnchor
            ? `${node.session.topic || node.session.id}${anchorLabel}`
            : undefined
        }
        style={{
          background:
            selectedSessionId === node.session.id
              ? 'var(--sam-color-bg-inset, #0d1816)'
              : node.depth > 0
                ? 'rgba(22,163,74,0.03)'
                : 'transparent',
          borderBottom:
            node.depth === 0
              ? '1px solid var(--sam-color-border-default, #29423b)'
              : undefined,
        }}
        className="transition-colors hover:!bg-[var(--sam-color-bg-surface-hover)]"
      >
        <div className="flex items-stretch">
          {/* Expand/collapse affordance — only when has children */}
          {hasChildren ? (
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
                  ? `Hide ${node.totalDescendants} descendant session${node.totalDescendants !== 1 ? 's' : ''}`
                  : `Show ${node.totalDescendants} descendant session${node.totalDescendants !== 1 ? 's' : ''}`
              }
              className="shrink-0 bg-transparent border-none cursor-pointer flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)]"
              style={{
                width: 22,
                minHeight: 44,
                color: 'var(--sam-color-fg-muted)',
                padding: 0,
              }}
            >
              {effectiveExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span style={{ width: 22 }} aria-hidden="true" />
          )}

          <div className="flex-1 min-w-0">
            <SessionItem
              session={node.session}
              isSelected={selectedSessionId === node.session.id}
              onSelect={onSelect}
              onFork={onFork}
              ideaTitle={ideaTitle}
              variant={variant}
              badge={
                <>
                  {node.isContextAnchor && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      title="Ancestor of an active chat — shown for context"
                      style={{
                        fontSize: 9,
                        color: 'var(--sam-color-fg-muted)',
                        background: 'rgba(255,255,255,0.04)',
                        padding: '0 5px',
                        borderRadius: 9999,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <EyeOff size={8} /> Context
                    </span>
                  )}
                  {node.depth >= MAX_VISUAL_DEPTH && (
                    <span
                      title={`Nested ${node.depth + 1} levels deep`}
                      style={{
                        background: 'rgba(245,158,11,0.15)',
                        color: '#f59e0b',
                        padding: '0 5px',
                        borderRadius: 9999,
                        fontSize: 10,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      L{node.depth + 1}
                    </span>
                  )}
                  {node.totalDescendants > 0 && (
                    <span
                      style={{
                        background: 'rgba(59,130,246,0.15)',
                        color: '#60a5fa',
                        padding: '0 5px',
                        borderRadius: 9999,
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                      title={`${node.totalDescendants} descendant session${node.totalDescendants !== 1 ? 's' : ''}`}
                    >
                      {node.totalDescendants} {node.children.length === node.totalDescendants ? 'SUB' : 'NESTED'}
                    </span>
                  )}
                </>
              }
              progressBar={
                node.totalDescendants > 0 ? (
                  <SubTaskProgressBar
                    completed={node.completedDescendants}
                    total={node.totalDescendants}
                  />
                ) : undefined
              }
              blockedBadge={taskInfo?.blocked}
              blockedByTitle={blockedByTitle}
            />
          </div>
        </div>
      </div>

      {/* Recursive children container — each level adds one rail + indent,
          capped at MAX_VISUAL_DEPTH so very deep trees don't overflow on
          mobile (375px). Beyond the cap, nesting continues but indent does
          not — a depth badge (L6, L7, ...) shows the true depth instead. */}
      {effectiveExpanded && hasChildren && (
        <div
          id={childrenId}
          style={{
            marginLeft:
              node.depth < MAX_VISUAL_DEPTH
                ? INDENT_PX
                : 0,
            borderLeft:
              node.depth < MAX_VISUAL_DEPTH
                ? '2px solid rgba(22,163,74,0.25)'
                : undefined,
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

/**
 * Find the title of the task a blocked item is waiting on. Falls back to the
 * parent task's title since full dependency data isn't available on the list
 * endpoint.
 */
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
