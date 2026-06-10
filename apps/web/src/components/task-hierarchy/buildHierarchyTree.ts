import type { ChatSessionListItem } from '../../lib/api';
import { isRetryOrFork } from '../../pages/project-chat/lineageUtils';
import type { TaskInfo } from '../../pages/project-chat/useTaskGroups';

export interface HierarchyNode {
  task: {
    id: string;
    title: string;
    status: string;
    blocked: boolean;
    agentType?: string;
  };
  children: HierarchyNode[];
  sessionId: string | null;
  startedAt: number | null;
}

/**
 * Build a tree of hierarchy nodes from the taskInfoMap, focused on a given task.
 *
 * Walks parentTaskId chains up to find the root, then walks down to find all descendants.
 * Uses `isRetryOrFork()` for consistent classification with the sidebar tree:
 * - Retries/forks (user-triggered with parentTaskId) are NOT nested as children.
 * - Only genuine subtasks (triggeredBy=mcp or dispatchDepth>0) are nested.
 */
export function buildHierarchyTree(
  taskInfoMap: Map<string, TaskInfo>,
  sessions: ChatSessionListItem[],
  focusTaskId: string,
): { tree: HierarchyNode; rootTaskId: string } | null {
  const focusTask = taskInfoMap.get(focusTaskId);
  if (!focusTask) return null;

  // Build session lookup
  const taskToSession = new Map<string, ChatSessionListItem>();
  for (const s of sessions) {
    if (s.taskId) taskToSession.set(s.taskId, s);
  }

  // Walk up to find root (only follow genuine subtask chains, not retries/forks)
  let rootTaskId = focusTaskId;
  const visited = new Set<string>([rootTaskId]);
  let cursor = focusTask;
  while (cursor.parentTaskId) {
    const parent = taskInfoMap.get(cursor.parentTaskId);
    if (!parent) break; // orphaned parent
    // If cursor is a retry/fork, don't walk up — cursor IS the tree root context
    if (isRetryOrFork(cursor)) break;
    if (visited.has(parent.id)) break; // cycle guard
    visited.add(parent.id);
    rootTaskId = parent.id;
    cursor = parent;
  }

  // Build children index (only genuine subtasks)
  const childrenOf = new Map<string, string[]>();
  for (const [taskId, info] of taskInfoMap) {
    if (!info.parentTaskId) continue;
    if (isRetryOrFork(info)) continue; // retries/forks are NOT children in the tree
    const siblings = childrenOf.get(info.parentTaskId) ?? [];
    siblings.push(taskId);
    childrenOf.set(info.parentTaskId, siblings);
  }

  // Recursively build tree (bounded depth)
  const MAX_DEPTH = 10;
  function buildNode(taskId: string, depth: number): HierarchyNode {
    const info = taskInfoMap.get(taskId)!;
    const session = taskToSession.get(taskId);

    const childIds = depth < MAX_DEPTH ? (childrenOf.get(taskId) ?? []) : [];
    // Sort children by session startedAt (or fallback to ID)
    childIds.sort((a, b) => {
      const sa = taskToSession.get(a);
      const sb = taskToSession.get(b);
      if (sa && sb) return sa.startedAt - sb.startedAt;
      return a.localeCompare(b);
    });

    return {
      task: {
        id: info.id,
        title: info.title,
        status: info.status,
        blocked: info.blocked,
      },
      children: childIds.map((id) => buildNode(id, depth + 1)),
      sessionId: session?.id ?? null,
      startedAt: session?.startedAt ?? null,
    };
  }

  const rootInfo = taskInfoMap.get(rootTaskId);
  if (!rootInfo) return null;

  return {
    tree: buildNode(rootTaskId, 0),
    rootTaskId,
  };
}

/** Count total nodes in a tree. */
export function countNodes(node: HierarchyNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

/** Check if a node or any descendant has the given task ID. */
export function containsFocus(node: HierarchyNode, focusTaskId: string): boolean {
  if (node.task.id === focusTaskId) return true;
  return node.children.some((c) => containsFocus(c, focusTaskId));
}

/** Check if any descendant matches a set of IDs. */
export function hasMatchingDescendant(node: HierarchyNode, matchIds: Set<string>): boolean {
  for (const child of node.children) {
    if (matchIds.has(child.task.id) || hasMatchingDescendant(child, matchIds)) return true;
  }
  return false;
}

/** Walk from root to focus node, returning the ancestor path (root first). */
export function getAncestorPath(
  tree: HierarchyNode,
  focusTaskId: string,
): HierarchyNode[] {
  const path: HierarchyNode[] = [];
  function walk(node: HierarchyNode): boolean {
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
  return path.reverse();
}

/** Check if a node matches a text query. */
function nodeMatchesQuery(node: HierarchyNode, queryLower: string): boolean {
  return (
    node.task.title.toLowerCase().includes(queryLower) ||
    node.task.status.toLowerCase().includes(queryLower) ||
    (node.task.blocked && 'blocked'.includes(queryLower))
  );
}

/** Filter tree, preserving ancestor chains for matching descendants. */
export function filterTree(node: HierarchyNode, query: string): HierarchyNode | null {
  const q = query.toLowerCase();
  const selfMatch = nodeMatchesQuery(node, q);
  const filteredChildren: HierarchyNode[] = [];
  for (const child of node.children) {
    const fc = filterTree(child, query);
    if (fc) filteredChildren.push(fc);
  }
  if (selfMatch || filteredChildren.length > 0) {
    return { ...node, children: selfMatch ? node.children : filteredChildren };
  }
  return null;
}

/** Collect IDs of all nodes that directly match the query (not just ancestors). */
export function collectMatchIds(node: HierarchyNode, query: string): Set<string> {
  const q = query.toLowerCase();
  const ids = new Set<string>();
  function walk(n: HierarchyNode) {
    if (nodeMatchesQuery(n, q)) ids.add(n.task.id);
    n.children.forEach(walk);
  }
  walk(node);
  return ids;
}

/**
 * Determine if a task has hierarchy relationships (parent or children) in the taskInfoMap.
 * Used to decide whether to show the hierarchy trigger button.
 */
export function hasHierarchy(
  taskId: string,
  taskInfoMap: Map<string, TaskInfo>,
): boolean {
  const info = taskInfoMap.get(taskId);
  if (!info) return false;

  // Has a parent and is a genuine subtask (not retry/fork)?
  if (info.parentTaskId && !isRetryOrFork(info)) return true;

  // Has children that are genuine subtasks?
  for (const [, other] of taskInfoMap) {
    if (other.parentTaskId === taskId && !isRetryOrFork(other)) return true;
  }

  return false;
}
