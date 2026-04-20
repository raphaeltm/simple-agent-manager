import type { TaskStatus } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';
import type { TaskInfo } from './useTaskGroups';

/**
 * A node in the session hierarchy rendered in the chat sidebar.
 *
 * Hierarchy is derived from task.parentTaskId (arbitrary depth). Sessions
 * without a taskId, or whose task has no parent in the resolved tree, are
 * roots.
 */
export interface SessionTreeNode {
  session: ChatSessionResponse;
  children: SessionTreeNode[];
  /** Depth from the tree root (0 = root-level). */
  depth: number;
  /**
   * True if this node is a "context anchor" — an ancestor that wasn't in the
   * primary `visibleSessions` input, lifted in from `allSessions` so the
   * descendant still appears with its lineage. Rendered dimmed in the UI.
   */
  isContextAnchor: boolean;
  /** Total descendant count (across all depths). */
  totalDescendants: number;
  /** Completed (terminal) descendant count. */
  completedDescendants: number;
}

/** Terminal task statuses that count as "completed" for progress. */
const COMPLETED_STATUSES = new Set<TaskStatus>(['completed']);

interface BuildSessionTreeOptions {
  /**
   * Full flat session list used to resolve context-anchor ancestors. When
   * provided, any ancestor of a visible session that is NOT in
   * `visibleSessions` but IS in `allSessions` will be lifted in as a dimmed
   * anchor, preserving lineage visibility.
   */
  allSessions?: ChatSessionResponse[];
}

/**
 * Build a recursive forest of session nodes using task.parentTaskId.
 *
 * - Arbitrary depth is supported.
 * - Sessions with no taskId, or whose task has no resolvable parent session,
 *   become roots.
 * - Orphan children (task has a parentTaskId but no session exists for that
 *   parent, in either `visibleSessions` or `allSessions`) are promoted to
 *   roots instead of being dropped.
 * - Root order preserves the input order of `visibleSessions`. If a root is a
 *   lifted anchor, it takes the position of its first visible descendant.
 */
export function buildSessionTree(
  visibleSessions: ChatSessionResponse[],
  taskInfoMap: Map<string, TaskInfo>,
  options: BuildSessionTreeOptions = {},
): SessionTreeNode[] {
  const { allSessions } = options;
  const visibleIds = new Set(visibleSessions.map((s) => s.id));

  // Build taskId -> session from allSessions when available (for anchor lookup),
  // falling back to visibleSessions. Entries in allSessions override to ensure
  // we pick anchors from the full list.
  const taskToSession = new Map<string, ChatSessionResponse>();
  for (const s of visibleSessions) {
    if (s.taskId) taskToSession.set(s.taskId, s);
  }
  if (allSessions) {
    for (const s of allSessions) {
      if (s.taskId && !taskToSession.has(s.taskId)) {
        taskToSession.set(s.taskId, s);
      }
    }
  }

  // Accumulator of sessions that will appear in the tree. Seeded with visible,
  // then extended with ancestor anchors as we walk up.
  const includedSessionsById = new Map<string, ChatSessionResponse>();
  for (const s of visibleSessions) includedSessionsById.set(s.id, s);

  /**
   * Walk up the task-parent chain for a given session, lifting ancestors into
   * the tree as context anchors. Stops when:
   * - The task has no parentTaskId (reached a root)
   * - The parent task has no session (orphan; treat current as root)
   * - The parent session is already in the included set (avoid double-walk)
   */
  const walkAncestors = (session: ChatSessionResponse) => {
    if (!session.taskId) return;
    let cursor: ChatSessionResponse | undefined = session;
    const seen = new Set<string>([session.id]);
    while (cursor?.taskId) {
      const info = taskInfoMap.get(cursor.taskId);
      if (!info?.parentTaskId) return;
      const parentSession = taskToSession.get(info.parentTaskId);
      if (!parentSession) return; // orphan — stop here
      if (seen.has(parentSession.id)) return; // cycle guard
      seen.add(parentSession.id);
      if (!includedSessionsById.has(parentSession.id)) {
        includedSessionsById.set(parentSession.id, parentSession);
      }
      cursor = parentSession;
    }
  };

  if (allSessions) {
    for (const s of visibleSessions) walkAncestors(s);
  }

  // Create a node per included session
  const nodesById = new Map<string, SessionTreeNode>();
  for (const [, session] of includedSessionsById) {
    nodesById.set(session.id, {
      session,
      children: [],
      depth: 0, // filled in later
      isContextAnchor: !visibleIds.has(session.id),
      totalDescendants: 0,
      completedDescendants: 0,
    });
  }

  // Resolve parent pointers; attach children to parents.
  // Detect ancestry cycles by walking upward from each node — any node whose
  // parent chain revisits itself is promoted to a root to avoid infinite
  // recursion in downstream tree walks.
  const rootIds: string[] = [];
  const firstVisibleDescendantOrder = new Map<string, number>();

  const hasCycle = (startId: string): boolean => {
    const seen = new Set<string>();
    let cursor: string | undefined = startId;
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      const node = nodesById.get(cursor);
      if (!node) return false;
      const info = node.session.taskId ? taskInfoMap.get(node.session.taskId) : undefined;
      const parentSess = info?.parentTaskId ? taskToSession.get(info.parentTaskId) : undefined;
      if (!parentSess || !nodesById.has(parentSess.id)) return false;
      cursor = parentSess.id;
    }
    return false;
  };

  for (const [sessionId, node] of nodesById) {
    const { session } = node;
    const info = session.taskId ? taskInfoMap.get(session.taskId) : undefined;
    const parentTaskId = info?.parentTaskId ?? null;
    const parentSession = parentTaskId ? taskToSession.get(parentTaskId) : undefined;
    const parentNode = parentSession ? nodesById.get(parentSession.id) : undefined;

    if (parentNode && !hasCycle(sessionId)) {
      parentNode.children.push(node);
    } else {
      rootIds.push(sessionId);
    }
  }

  // Determine sort order for roots based on first visible descendant's index
  // in visibleSessions (so anchor ancestors appear at the position of their
  // earliest-visible descendant).
  visibleSessions.forEach((s, idx) => {
    // Walk up via nodesById to find the topmost ancestor in the tree.
    let nodeId: string | undefined = s.id;
    let topId: string = s.id;
    const walked = new Set<string>();
    while (nodeId && !walked.has(nodeId)) {
      walked.add(nodeId);
      const node = nodesById.get(nodeId);
      if (!node) break;
      topId = node.session.id;
      // Find parent id
      const info = node.session.taskId ? taskInfoMap.get(node.session.taskId) : undefined;
      const parentSess = info?.parentTaskId ? taskToSession.get(info.parentTaskId) : undefined;
      if (!parentSess || !nodesById.has(parentSess.id)) break;
      nodeId = parentSess.id;
    }
    if (!firstVisibleDescendantOrder.has(topId)) {
      firstVisibleDescendantOrder.set(topId, idx);
    }
  });

  // Sort roots by first-visible-descendant order; roots with no visible
  // descendant sink to the end preserving creation order.
  rootIds.sort((a, b) => {
    const ai = firstVisibleDescendantOrder.get(a) ?? Number.POSITIVE_INFINITY;
    const bi = firstVisibleDescendantOrder.get(b) ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });

  // Sort children at every level by their session's startedAt (stable fallback
  // to id) — oldest first so tree reads top-down chronologically.
  const sortChildren = (node: SessionTreeNode) => {
    node.children.sort((a, b) => {
      const at = a.session.startedAt;
      const bt = b.session.startedAt;
      if (at !== bt) return at - bt;
      return a.session.id.localeCompare(b.session.id);
    });
    for (const c of node.children) sortChildren(c);
  };

  const roots = rootIds.map((id) => nodesById.get(id)!);
  for (const root of roots) sortChildren(root);

  // Compute depth and descendant aggregates in one post-order pass.
  const annotate = (node: SessionTreeNode, depth: number): void => {
    node.depth = depth;
    node.totalDescendants = 0;
    node.completedDescendants = 0;
    for (const child of node.children) {
      annotate(child, depth + 1);
      const childInfo = child.session.taskId
        ? taskInfoMap.get(child.session.taskId)
        : undefined;
      const childCompleted = childInfo && COMPLETED_STATUSES.has(childInfo.status) ? 1 : 0;
      node.totalDescendants += 1 + child.totalDescendants;
      node.completedDescendants += childCompleted + child.completedDescendants;
    }
  };
  for (const root of roots) annotate(root, 0);

  return roots;
}

/**
 * Returns true if any node in the subtree rooted at `node` has a topic, id,
 * or task-title that matches the query.
 */
export function treeHasMatchingDescendant(
  node: SessionTreeNode,
  query: string,
  taskInfoMap: Map<string, TaskInfo>,
): boolean {
  const q = query.toLowerCase();
  return node.children.some((child) => nodeMatches(child, q, taskInfoMap) || treeHasMatchingDescendant(child, query, taskInfoMap));
}

function nodeMatches(
  node: SessionTreeNode,
  queryLower: string,
  taskInfoMap: Map<string, TaskInfo>,
): boolean {
  const topic = node.session.topic?.toLowerCase() ?? '';
  const id = node.session.id.toLowerCase();
  const title = node.session.taskId
    ? (taskInfoMap.get(node.session.taskId)?.title?.toLowerCase() ?? '')
    : '';
  return topic.includes(queryLower) || id.includes(queryLower) || title.includes(queryLower);
}
