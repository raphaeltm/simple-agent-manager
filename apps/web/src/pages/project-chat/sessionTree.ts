import type { TaskStatus } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';
import type { TaskInfo } from './useTaskGroups';

/**
 * A node in the session hierarchy rendered in the chat sidebar.
 *
 * After the chat-list redesign, retries and forks (user-triggered sessions
 * with a parentTaskId) are promoted to root level with lineage subtitle text.
 * Only genuine agent-dispatched subtasks (triggeredBy=mcp) remain as children.
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
  /** Lineage subtitle text for flattened retries/forks (e.g., "↩ attempt 3"). */
  lineageText?: string;
}

/** Terminal task statuses that count as "completed" for progress. */
const COMPLETED_STATUSES = new Set<TaskStatus>(['completed']);

interface BuildSessionTreeOptions {
  allSessions?: ChatSessionResponse[];
}

/**
 * Determine whether a session with a parentTaskId is a retry/fork (user-triggered)
 * vs a genuine agent-dispatched subtask (triggeredBy=mcp).
 *
 * Retries and forks are flattened to root level; genuine subtasks remain children.
 */
function isRetryOrFork(taskInfo: TaskInfo): boolean {
  // Agent-dispatched subtasks have triggeredBy=mcp — keep those as children.
  // Everything else (user, cron, webhook) with a parentTaskId is a retry or fork.
  return taskInfo.triggeredBy !== 'mcp';
}

/**
 * Build lineage text for a flattened retry/fork.
 *
 * Counts how many siblings share the same parent to determine attempt number.
 * If only 1 sibling exists, it's a fork. Otherwise, ordered by creation time.
 */
function buildLineageText(
  taskInfo: TaskInfo,
  taskInfoMap: Map<string, TaskInfo>,
  allSessionsByTaskId: Map<string, ChatSessionResponse>,
): string {
  if (!taskInfo.parentTaskId) return '';

  const parentInfo = taskInfoMap.get(taskInfo.parentTaskId);
  const parentSession = parentInfo ? allSessionsByTaskId.get(taskInfo.parentTaskId) : undefined;
  const parentLabel = parentSession?.topic
    ? parentSession.topic.slice(0, 30) + (parentSession.topic.length > 30 ? '…' : '')
    : parentInfo?.title
      ? parentInfo.title.slice(0, 30) + (parentInfo.title.length > 30 ? '…' : '')
      : 'earlier attempt';

  // Count siblings that share the same parent and are also retries/forks
  const siblings: { taskId: string; startedAt: number }[] = [];
  for (const [, info] of taskInfoMap) {
    if (info.parentTaskId === taskInfo.parentTaskId && isRetryOrFork(info)) {
      const sess = allSessionsByTaskId.get(info.id);
      siblings.push({ taskId: info.id, startedAt: sess?.startedAt ?? 0 });
    }
  }

  if (siblings.length <= 1) {
    // Single derived session — it's a fork
    return `⑂ from ${parentLabel}`;
  }

  // Multiple siblings — they're retries. Sort by startedAt to get attempt number.
  siblings.sort((a, b) => a.startedAt - b.startedAt);
  const attemptIndex = siblings.findIndex((s) => s.taskId === taskInfo.id);
  // Attempt numbering: parent is attempt 1, first retry is attempt 2, etc.
  return `↩ attempt ${attemptIndex + 2}`;
}

/**
 * Build a forest of session nodes.
 *
 * - Retries and forks (user-triggered with parentTaskId) are promoted to root
 *   level with lineage subtitle text.
 * - Only genuine agent-dispatched subtasks (triggeredBy=mcp) remain as children.
 * - Context anchors are lifted in from allSessions when needed.
 */
export function buildSessionTree(
  visibleSessions: ChatSessionResponse[],
  taskInfoMap: Map<string, TaskInfo>,
  options: BuildSessionTreeOptions = {},
): SessionTreeNode[] {
  const { allSessions } = options;
  const visibleIds = new Set(visibleSessions.map((s) => s.id));

  // Build taskId -> session maps
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

  // Accumulator of sessions that will appear in the tree
  const includedSessionsById = new Map<string, ChatSessionResponse>();
  for (const s of visibleSessions) includedSessionsById.set(s.id, s);

  // Walk up ancestors for context anchors — but only for genuine subtask chains
  const walkAncestors = (session: ChatSessionResponse) => {
    if (!session.taskId) return;
    const info = taskInfoMap.get(session.taskId);
    // Don't walk up if this is a retry/fork — it will be promoted to root
    if (info && isRetryOrFork(info) && info.parentTaskId) return;

    let cursor: ChatSessionResponse | undefined = session;
    const seen = new Set<string>([session.id]);
    while (cursor?.taskId) {
      const curInfo = taskInfoMap.get(cursor.taskId);
      if (!curInfo?.parentTaskId) return;
      // Stop walking if the parent is a retry/fork — don't lift those as anchors
      const parentInfo = taskInfoMap.get(curInfo.parentTaskId);
      if (parentInfo && isRetryOrFork(parentInfo) && parentInfo.parentTaskId) return;

      const parentSession = taskToSession.get(curInfo.parentTaskId);
      if (!parentSession) return;
      if (seen.has(parentSession.id)) return;
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

  // Create nodes
  const nodesById = new Map<string, SessionTreeNode>();
  for (const [, session] of includedSessionsById) {
    const info = session.taskId ? taskInfoMap.get(session.taskId) : undefined;

    nodesById.set(session.id, {
      session,
      children: [],
      depth: 0,
      isContextAnchor: !visibleIds.has(session.id),
      totalDescendants: 0,
      completedDescendants: 0,
      lineageText: undefined, // populated below for flattened retries/forks
    });

    // If this is a retry/fork with a parent, compute lineage text
    if (info && info.parentTaskId && isRetryOrFork(info)) {
      const node = nodesById.get(session.id)!;
      node.lineageText = buildLineageText(info, taskInfoMap, taskToSession);
    }
  }

  // Resolve parent pointers — only attach genuine subtasks as children
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
      // Only follow genuine subtask parent chains (not retries/forks)
      if (!info?.parentTaskId || isRetryOrFork(info)) return false;
      const parentSess = taskToSession.get(info.parentTaskId);
      if (!parentSess || !nodesById.has(parentSess.id)) return false;
      cursor = parentSess.id;
    }
    return false;
  };

  for (const [sessionId, node] of nodesById) {
    const { session } = node;
    const info = session.taskId ? taskInfoMap.get(session.taskId) : undefined;
    const parentTaskId = info?.parentTaskId ?? null;

    // Retries/forks are always roots
    if (info && parentTaskId && isRetryOrFork(info)) {
      rootIds.push(sessionId);
      continue;
    }

    const parentSession = parentTaskId ? taskToSession.get(parentTaskId) : undefined;
    const parentNode = parentSession ? nodesById.get(parentSession.id) : undefined;

    if (parentNode && !hasCycle(sessionId)) {
      parentNode.children.push(node);
    } else {
      rootIds.push(sessionId);
    }
  }

  // Sort roots by first-visible-descendant order
  visibleSessions.forEach((s, idx) => {
    let nodeId: string | undefined = s.id;
    let topId: string = s.id;
    const walked = new Set<string>();
    while (nodeId && !walked.has(nodeId)) {
      walked.add(nodeId);
      const node = nodesById.get(nodeId);
      if (!node) break;
      topId = node.session.id;
      const info = node.session.taskId ? taskInfoMap.get(node.session.taskId) : undefined;
      if (!info?.parentTaskId || isRetryOrFork(info)) break;
      const parentSess = taskToSession.get(info.parentTaskId);
      if (!parentSess || !nodesById.has(parentSess.id)) break;
      nodeId = parentSess.id;
    }
    if (!firstVisibleDescendantOrder.has(topId)) {
      firstVisibleDescendantOrder.set(topId, idx);
    }
  });

  rootIds.sort((a, b) => {
    const ai = firstVisibleDescendantOrder.get(a) ?? Number.POSITIVE_INFINITY;
    const bi = firstVisibleDescendantOrder.get(b) ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });

  // Sort children chronologically
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

  // Compute depth and descendant aggregates
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
