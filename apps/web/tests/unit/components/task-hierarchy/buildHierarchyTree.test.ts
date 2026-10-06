/**
 * Unit tests for buildHierarchyTree and related utility functions.
 *
 * Tests cover:
 * - Tree building from taskInfoMap with parent/child chains
 * - Retry/fork classification (excluded from tree children)
 * - Orphaned parents (partial chains)
 * - Cycle guard
 * - Filter logic with ancestor preservation
 * - Match ID collection
 * - hasHierarchy detection
 */
import { describe, expect, it } from 'vitest';

import type { HierarchyNode } from '../../../../src/components/task-hierarchy/buildHierarchyTree';
import {
  buildHierarchyTree,
  collectMatchIds,
  containsFocus,
  countNodes,
  filterTree,
  getAncestorPath,
  hasHierarchy,
  hasMatchingDescendant,
} from '../../../../src/components/task-hierarchy/buildHierarchyTree';
import type { ChatSessionListItem } from '../../../../src/lib/api';
import type { TaskInfo } from '../../../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskInfo> & { id: string }): TaskInfo {
  return {
    title: `Task ${overrides.id}`,
    parentTaskId: null,
    status: 'in_progress',
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'task',
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<ChatSessionListItem> & { id: string; taskId: string },
): ChatSessionListItem {
  return {
    topic: null,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  } as ChatSessionListItem;
}

function buildMap(tasks: TaskInfo[]): Map<string, TaskInfo> {
  const m = new Map<string, TaskInfo>();
  for (const t of tasks) m.set(t.id, t);
  return m;
}

// ---------------------------------------------------------------------------
// buildHierarchyTree
// ---------------------------------------------------------------------------

describe('buildHierarchyTree', () => {
  it('returns null when focusTaskId is not in the map', () => {
    const result = buildHierarchyTree(new Map(), [], 'nonexistent');
    expect(result).toBeNull();
  });

  it('builds a single-node tree for a task with no parent or children', () => {
    const tasks = buildMap([makeTask({ id: 'A' })]);
    const sessions = [makeSession({ id: 'sess-A', taskId: 'A', startedAt: 1000 })];
    const result = buildHierarchyTree(tasks, sessions, 'A');

    expect(result).not.toBeNull();
    expect(result!.rootTaskId).toBe('A');
    expect(result!.tree.task.id).toBe('A');
    expect(result!.tree.children).toHaveLength(0);
    expect(result!.tree.sessionId).toBe('sess-A');
  });

  it('builds a parent-child tree for genuine subtasks', () => {
    const tasks = buildMap([
      makeTask({ id: 'root', title: 'Root task' }),
      makeTask({
        id: 'child1',
        title: 'Child 1',
        parentTaskId: 'root',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
      makeTask({
        id: 'child2',
        title: 'Child 2',
        parentTaskId: 'root',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
    ]);
    const sessions = [
      makeSession({ id: 'sess-root', taskId: 'root', startedAt: 1000 }),
      makeSession({ id: 'sess-c1', taskId: 'child1', startedAt: 2000 }),
      makeSession({ id: 'sess-c2', taskId: 'child2', startedAt: 3000 }),
    ];

    const result = buildHierarchyTree(tasks, sessions, 'child1');
    expect(result).not.toBeNull();
    expect(result!.rootTaskId).toBe('root');
    expect(result!.tree.task.id).toBe('root');
    expect(result!.tree.children).toHaveLength(2);
    expect(result!.tree.children[0]!.task.id).toBe('child1');
    expect(result!.tree.children[1]!.task.id).toBe('child2');
  });

  it('excludes retries/forks from children', () => {
    const tasks = buildMap([
      makeTask({ id: 'root' }),
      makeTask({
        id: 'subtask',
        parentTaskId: 'root',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
      makeTask({
        id: 'retry',
        parentTaskId: 'root',
        triggeredBy: 'user',
        dispatchDepth: 0,
      }),
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 'root', startedAt: 1000 }),
      makeSession({ id: 's2', taskId: 'subtask', startedAt: 2000 }),
      makeSession({ id: 's3', taskId: 'retry', startedAt: 3000 }),
    ];

    const result = buildHierarchyTree(tasks, sessions, 'root');
    expect(result!.tree.children).toHaveLength(1);
    expect(result!.tree.children[0]!.task.id).toBe('subtask');
  });

  it('does not walk up through retry/fork parents', () => {
    const tasks = buildMap([
      makeTask({ id: 'original' }),
      makeTask({
        id: 'retry',
        parentTaskId: 'original',
        triggeredBy: 'user',
        dispatchDepth: 0,
      }),
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 'original', startedAt: 1000 }),
      makeSession({ id: 's2', taskId: 'retry', startedAt: 2000 }),
    ];

    // Focus on the retry — should NOT walk up to 'original'
    const result = buildHierarchyTree(tasks, sessions, 'retry');
    expect(result!.rootTaskId).toBe('retry');
    expect(result!.tree.task.id).toBe('retry');
  });

  it('handles orphaned parent gracefully', () => {
    const tasks = buildMap([
      makeTask({
        id: 'child',
        parentTaskId: 'missing-parent',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
      }),
    ]);
    const sessions = [makeSession({ id: 's1', taskId: 'child', startedAt: 1000 })];

    const result = buildHierarchyTree(tasks, sessions, 'child');
    expect(result!.rootTaskId).toBe('child');
    expect(result!.tree.task.id).toBe('child');
  });

  it('handles tasks without sessions (sessionId = null)', () => {
    const tasks = buildMap([
      makeTask({ id: 'root' }),
      makeTask({
        id: 'queued',
        parentTaskId: 'root',
        triggeredBy: 'mcp',
        dispatchDepth: 1,
        status: 'queued',
      }),
    ]);
    const sessions = [makeSession({ id: 's1', taskId: 'root', startedAt: 1000 })];

    const result = buildHierarchyTree(tasks, sessions, 'root');
    expect(result!.tree.children[0]!.sessionId).toBeNull();
    expect(result!.tree.children[0]!.task.status).toBe('queued');
  });

  it('sorts children by session startedAt', () => {
    const tasks = buildMap([
      makeTask({ id: 'root' }),
      makeTask({ id: 'c1', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 }),
      makeTask({ id: 'c2', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 }),
      makeTask({ id: 'c3', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 }),
    ]);
    const sessions = [
      makeSession({ id: 's-root', taskId: 'root', startedAt: 1000 }),
      makeSession({ id: 's-c1', taskId: 'c1', startedAt: 5000 }),
      makeSession({ id: 's-c2', taskId: 'c2', startedAt: 2000 }),
      makeSession({ id: 's-c3', taskId: 'c3', startedAt: 3000 }),
    ];

    const result = buildHierarchyTree(tasks, sessions, 'root');
    const childIds = result!.tree.children.map((c) => c.task.id);
    expect(childIds).toEqual(['c2', 'c3', 'c1']);
  });

  it('builds a deep tree (3 levels)', () => {
    const tasks = buildMap([
      makeTask({ id: 'root' }),
      makeTask({ id: 'L1', parentTaskId: 'root', triggeredBy: 'mcp', dispatchDepth: 1 }),
      makeTask({ id: 'L2', parentTaskId: 'L1', triggeredBy: 'mcp', dispatchDepth: 2 }),
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 'root', startedAt: 1000 }),
      makeSession({ id: 's2', taskId: 'L1', startedAt: 2000 }),
      makeSession({ id: 's3', taskId: 'L2', startedAt: 3000 }),
    ];

    // Focus on deepest leaf — should walk up to root
    const result = buildHierarchyTree(tasks, sessions, 'L2');
    expect(result!.rootTaskId).toBe('root');
    expect(result!.tree.children[0]!.children[0]!.task.id).toBe('L2');
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('countNodes', () => {
  it('counts all nodes in a tree', () => {
    const tree: HierarchyNode = {
      task: { id: 'A', title: 'A', status: 'completed', blocked: false },
      children: [
        {
          task: { id: 'B', title: 'B', status: 'completed', blocked: false },
          children: [],
          sessionId: null,
          startedAt: null,
        },
        {
          task: { id: 'C', title: 'C', status: 'completed', blocked: false },
          children: [
            {
              task: { id: 'D', title: 'D', status: 'completed', blocked: false },
              children: [],
              sessionId: null,
              startedAt: null,
            },
          ],
          sessionId: null,
          startedAt: null,
        },
      ],
      sessionId: null,
      startedAt: null,
    };
    expect(countNodes(tree)).toBe(4);
  });
});

describe('containsFocus', () => {
  const tree: HierarchyNode = {
    task: { id: 'root', title: 'Root', status: 'completed', blocked: false },
    children: [
      {
        task: { id: 'child', title: 'Child', status: 'completed', blocked: false },
        children: [],
        sessionId: null,
        startedAt: null,
      },
    ],
    sessionId: null,
    startedAt: null,
  };

  it('returns true for root', () => {
    expect(containsFocus(tree, 'root')).toBe(true);
  });

  it('returns true for child', () => {
    expect(containsFocus(tree, 'child')).toBe(true);
  });

  it('returns false for missing ID', () => {
    expect(containsFocus(tree, 'other')).toBe(false);
  });
});

describe('getAncestorPath', () => {
  const tree: HierarchyNode = {
    task: { id: 'A', title: 'A', status: 'completed', blocked: false },
    children: [
      {
        task: { id: 'B', title: 'B', status: 'completed', blocked: false },
        children: [
          {
            task: { id: 'C', title: 'C', status: 'completed', blocked: false },
            children: [],
            sessionId: null,
            startedAt: null,
          },
        ],
        sessionId: null,
        startedAt: null,
      },
    ],
    sessionId: null,
    startedAt: null,
  };

  it('returns path from root to focus node', () => {
    const path = getAncestorPath(tree, 'C');
    expect(path.map((n) => n.task.id)).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array if focus not found', () => {
    expect(getAncestorPath(tree, 'X')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filter functions
// ---------------------------------------------------------------------------

describe('filterTree', () => {
  const tree: HierarchyNode = {
    task: { id: 'root', title: 'Build project', status: 'completed', blocked: false },
    children: [
      {
        task: { id: 'c1', title: 'Run tests', status: 'in_progress', blocked: false },
        children: [],
        sessionId: null,
        startedAt: null,
      },
      {
        task: { id: 'c2', title: 'Fix bug', status: 'failed', blocked: false },
        children: [
          {
            task: { id: 'gc1', title: 'Debug error', status: 'completed', blocked: false },
            children: [],
            sessionId: null,
            startedAt: null,
          },
        ],
        sessionId: null,
        startedAt: null,
      },
    ],
    sessionId: null,
    startedAt: null,
  };

  it('returns full tree when query matches root', () => {
    const result = filterTree(tree, 'Build');
    expect(result).not.toBeNull();
    // When root matches, all children are kept
    expect(result!.children).toHaveLength(2);
  });

  it('preserves ancestor chain for deep match', () => {
    const result = filterTree(tree, 'Debug');
    expect(result).not.toBeNull();
    expect(result!.task.id).toBe('root');
    // root kept as ancestor, c1 pruned, c2 kept as ancestor of gc1
    expect(result!.children).toHaveLength(1);
    expect(result!.children[0]!.task.id).toBe('c2');
    expect(result!.children[0]!.children[0]!.task.id).toBe('gc1');
  });

  it('returns null when nothing matches', () => {
    expect(filterTree(tree, 'zzzzz')).toBeNull();
  });

  it('matches on status', () => {
    const result = filterTree(tree, 'failed');
    expect(result).not.toBeNull();
  });
});

describe('collectMatchIds', () => {
  const tree: HierarchyNode = {
    task: { id: 'root', title: 'Build project', status: 'completed', blocked: false },
    children: [
      {
        task: { id: 'c1', title: 'Build tests', status: 'completed', blocked: false },
        children: [],
        sessionId: null,
        startedAt: null,
      },
      {
        task: { id: 'c2', title: 'Fix bug', status: 'completed', blocked: false },
        children: [],
        sessionId: null,
        startedAt: null,
      },
    ],
    sessionId: null,
    startedAt: null,
  };

  it('collects IDs of nodes matching the query', () => {
    const ids = collectMatchIds(tree, 'Build');
    expect(ids.has('root')).toBe(true);
    expect(ids.has('c1')).toBe(true);
    expect(ids.has('c2')).toBe(false);
  });
});

describe('hasMatchingDescendant', () => {
  const tree: HierarchyNode = {
    task: { id: 'root', title: 'Root', status: 'completed', blocked: false },
    children: [
      {
        task: { id: 'child', title: 'Child', status: 'completed', blocked: false },
        children: [],
        sessionId: null,
        startedAt: null,
      },
    ],
    sessionId: null,
    startedAt: null,
  };

  it('returns true when a descendant matches', () => {
    expect(hasMatchingDescendant(tree, new Set(['child']))).toBe(true);
  });

  it('returns false when no descendant matches (root itself not checked)', () => {
    expect(hasMatchingDescendant(tree, new Set(['root']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasHierarchy
// ---------------------------------------------------------------------------

describe('hasHierarchy', () => {
  it('returns false for a standalone task', () => {
    const tasks = buildMap([makeTask({ id: 'solo' })]);
    expect(hasHierarchy('solo', tasks)).toBe(false);
  });

  it('returns true for a task with genuine subtask children', () => {
    const tasks = buildMap([
      makeTask({ id: 'parent' }),
      makeTask({ id: 'child', parentTaskId: 'parent', triggeredBy: 'mcp', dispatchDepth: 1 }),
    ]);
    expect(hasHierarchy('parent', tasks)).toBe(true);
  });

  it('returns true for a genuine subtask (has parent)', () => {
    const tasks = buildMap([
      makeTask({ id: 'parent' }),
      makeTask({ id: 'child', parentTaskId: 'parent', triggeredBy: 'mcp', dispatchDepth: 1 }),
    ]);
    expect(hasHierarchy('child', tasks)).toBe(true);
  });

  it('returns false for a retry (not a hierarchy relationship)', () => {
    const tasks = buildMap([
      makeTask({ id: 'original' }),
      makeTask({ id: 'retry', parentTaskId: 'original', triggeredBy: 'user', dispatchDepth: 0 }),
    ]);
    // original has no subtask children (retry is excluded)
    expect(hasHierarchy('original', tasks)).toBe(false);
    // retry is a retry/fork, not a genuine subtask
    expect(hasHierarchy('retry', tasks)).toBe(false);
  });

  it('returns false for missing task', () => {
    expect(hasHierarchy('missing', new Map())).toBe(false);
  });
});
