import { describe, expect, it } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import {
  buildSessionTree,
  type SessionTreeNode,
  treeHasMatchingDescendant,
} from '../../src/pages/project-chat/sessionTree';
import type { TaskInfo } from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: null,
    taskId: null,
    topic: 'Test session',
    status: 'active',
    messageCount: 5,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test task',
    parentTaskId: null,
    status: 'in_progress',
    blocked: false,
    triggeredBy: 'user',
    ...overrides,
  };
}

/** Collect all node ids from a forest (pre-order). */
function collectIds(nodes: SessionTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (n: SessionTreeNode) => {
    out.push(n.session.id);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Find a node anywhere in the forest by session id. */
function findNode(nodes: SessionTreeNode[], id: string): SessionTreeNode | undefined {
  for (const n of nodes) {
    if (n.session.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe('buildSessionTree — basic structure', () => {
  it('returns depth-0 roots for standalone (no task) sessions', () => {
    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })];
    const roots = buildSessionTree(sessions, new Map());
    expect(roots).toHaveLength(2);
    expect(roots[0]!.depth).toBe(0);
    expect(roots[0]!.children).toHaveLength(0);
    expect(roots[0]!.isContextAnchor).toBe(false);
    expect(roots[0]!.totalDescendants).toBe(0);
  });

  it('links a single child to its parent (depth 1)', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP' }),
      makeSession({ id: 'sC', taskId: 'tC' }),
    ];

    const roots = buildSessionTree(sessions, tasks);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe('sP');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.session.id).toBe('sC');
    expect(roots[0]!.children[0]!.depth).toBe(1);
  });

  it('supports arbitrary depth (grandchild, great-grandchild)', () => {
    const tasks = new Map<string, TaskInfo>([
      ['t1', makeTaskInfo({ id: 't1', parentTaskId: null })],
      ['t2', makeTaskInfo({ id: 't2', parentTaskId: 't1' })],
      ['t3', makeTaskInfo({ id: 't3', parentTaskId: 't2' })],
      ['t4', makeTaskInfo({ id: 't4', parentTaskId: 't3' })],
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 't1' }),
      makeSession({ id: 's2', taskId: 't2' }),
      makeSession({ id: 's3', taskId: 't3' }),
      makeSession({ id: 's4', taskId: 't4' }),
    ];

    const roots = buildSessionTree(sessions, tasks);
    expect(roots).toHaveLength(1);

    const s4 = findNode(roots, 's4')!;
    expect(s4).toBeDefined();
    expect(s4.depth).toBe(3);
    expect(findNode(roots, 's3')!.depth).toBe(2);
    expect(findNode(roots, 's2')!.depth).toBe(1);
    expect(findNode(roots, 's1')!.depth).toBe(0);
  });

  it('supports 5+ levels deep without data loss', () => {
    const tasks = new Map<string, TaskInfo>();
    const sessions: ChatSessionResponse[] = [];
    for (let i = 1; i <= 6; i++) {
      tasks.set(`t${i}`, makeTaskInfo({
        id: `t${i}`,
        parentTaskId: i === 1 ? null : `t${i - 1}`,
      }));
      sessions.push(makeSession({ id: `s${i}`, taskId: `t${i}` }));
    }

    const roots = buildSessionTree(sessions, tasks);
    expect(roots).toHaveLength(1);
    expect(findNode(roots, 's6')!.depth).toBe(5);
    expect(collectIds(roots)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });
});

// ---------------------------------------------------------------------------
// Context anchors
// ---------------------------------------------------------------------------

describe('buildSessionTree — context anchors (stale ancestors)', () => {
  it('lifts a stopped parent as a context anchor when its child is visible', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null, status: 'completed' })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP' })],
    ]);
    // Parent is in `allSessions` but NOT in visible `sessions`
    const stoppedParent = makeSession({ id: 'sP', taskId: 'tP', status: 'stopped' });
    const activeChild = makeSession({ id: 'sC', taskId: 'tC' });

    const roots = buildSessionTree([activeChild], tasks, { allSessions: [stoppedParent, activeChild] });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe('sP');
    expect(roots[0]!.isContextAnchor).toBe(true);
    expect(roots[0]!.children[0]!.session.id).toBe('sC');
    expect(roots[0]!.children[0]!.isContextAnchor).toBe(false);
  });

  it('lifts a grandparent anchor so a grandchild stays visible', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tGP', makeTaskInfo({ id: 'tGP', parentTaskId: null, status: 'completed' })],
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: 'tGP', status: 'completed' })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP', status: 'in_progress' })],
    ]);
    const gp = makeSession({ id: 'sGP', taskId: 'tGP', status: 'stopped' });
    const p = makeSession({ id: 'sP', taskId: 'tP', status: 'stopped' });
    const c = makeSession({ id: 'sC', taskId: 'tC' });

    const roots = buildSessionTree([c], tasks, { allSessions: [gp, p, c] });
    // Expect: sGP (anchor) → sP (anchor) → sC (visible)
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe('sGP');
    expect(roots[0]!.isContextAnchor).toBe(true);
    expect(roots[0]!.children[0]!.session.id).toBe('sP');
    expect(roots[0]!.children[0]!.isContextAnchor).toBe(true);
    expect(roots[0]!.children[0]!.children[0]!.session.id).toBe('sC');
    expect(roots[0]!.children[0]!.children[0]!.isContextAnchor).toBe(false);
  });

  it('does NOT create anchors when allSessions is not provided', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP' })],
    ]);
    const c = makeSession({ id: 'sC', taskId: 'tC' });

    // Only child is visible, no allSessions — should render as orphan root.
    const roots = buildSessionTree([c], tasks);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe('sC');
    expect(roots[0]!.isContextAnchor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Siblings, multiple roots, ordering
// ---------------------------------------------------------------------------

describe('buildSessionTree — siblings and ordering', () => {
  it('groups multiple siblings under the same parent', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tC1', makeTaskInfo({ id: 'tC1', parentTaskId: 'tP', status: 'completed' })],
      ['tC2', makeTaskInfo({ id: 'tC2', parentTaskId: 'tP', status: 'in_progress' })],
      ['tC3', makeTaskInfo({ id: 'tC3', parentTaskId: 'tP', status: 'in_progress' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP', startedAt: 1000 }),
      makeSession({ id: 'sC1', taskId: 'tC1', startedAt: 1100 }),
      makeSession({ id: 'sC2', taskId: 'tC2', startedAt: 1200 }),
      makeSession({ id: 'sC3', taskId: 'tC3', startedAt: 1300 }),
    ];

    const roots = buildSessionTree(sessions, tasks);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children).toHaveLength(3);
    expect(roots[0]!.totalDescendants).toBe(3);
    expect(roots[0]!.completedDescendants).toBe(1);
  });

  it('sorts children by startedAt ascending', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tA', makeTaskInfo({ id: 'tA', parentTaskId: 'tP' })],
      ['tB', makeTaskInfo({ id: 'tB', parentTaskId: 'tP' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP', startedAt: 1000 }),
      // B has earlier startedAt than A, so should come first
      makeSession({ id: 'sA', taskId: 'tA', startedAt: 1200 }),
      makeSession({ id: 'sB', taskId: 'tB', startedAt: 1100 }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(roots[0]!.children.map((c) => c.session.id)).toEqual(['sB', 'sA']);
  });

  it('promotes orphan children (parent not in either list) to roots', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tMissing' })],
    ]);
    const roots = buildSessionTree([makeSession({ id: 'sC', taskId: 'tC' })], tasks);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.session.id).toBe('sC');
  });

  it('keeps no-taskId sessions as independent roots', () => {
    const sessions = [
      makeSession({ id: 's1', taskId: null }),
      makeSession({ id: 's2', taskId: null }),
    ];
    const roots = buildSessionTree(sessions, new Map());
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => !r.isContextAnchor)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Descendant aggregates
// ---------------------------------------------------------------------------

describe('buildSessionTree — descendant aggregates', () => {
  it('computes totalDescendants across all levels', () => {
    const tasks = new Map<string, TaskInfo>([
      ['t1', makeTaskInfo({ id: 't1', parentTaskId: null })],
      ['t2', makeTaskInfo({ id: 't2', parentTaskId: 't1' })],
      ['t3', makeTaskInfo({ id: 't3', parentTaskId: 't2' })],
      ['t4', makeTaskInfo({ id: 't4', parentTaskId: 't2' })],
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 't1' }),
      makeSession({ id: 's2', taskId: 't2' }),
      makeSession({ id: 's3', taskId: 't3' }),
      makeSession({ id: 's4', taskId: 't4' }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(roots[0]!.totalDescendants).toBe(3); // s2, s3, s4
    expect(findNode(roots, 's2')!.totalDescendants).toBe(2); // s3, s4
  });

  it('computes completedDescendants from terminal task status', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tA', makeTaskInfo({ id: 'tA', parentTaskId: 'tP', status: 'completed' })],
      ['tB', makeTaskInfo({ id: 'tB', parentTaskId: 'tP', status: 'completed' })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP', status: 'in_progress' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP' }),
      makeSession({ id: 'sA', taskId: 'tA' }),
      makeSession({ id: 'sB', taskId: 'tB' }),
      makeSession({ id: 'sC', taskId: 'tC' }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(roots[0]!.totalDescendants).toBe(3);
    expect(roots[0]!.completedDescendants).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('buildSessionTree — edge cases', () => {
  it('empty input yields empty forest', () => {
    expect(buildSessionTree([], new Map())).toEqual([]);
  });

  it('handles a cycle in taskInfoMap without infinite loop', () => {
    // Pathological: t1 claims t2 as parent, t2 claims t1 as parent.
    const tasks = new Map<string, TaskInfo>([
      ['t1', makeTaskInfo({ id: 't1', parentTaskId: 't2' })],
      ['t2', makeTaskInfo({ id: 't2', parentTaskId: 't1' })],
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 't1' }),
      makeSession({ id: 's2', taskId: 't2' }),
    ];
    // Should not throw / hang
    const roots = buildSessionTree(sessions, tasks);
    // Both sessions should appear exactly once somewhere in the forest
    const ids = collectIds(roots);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
  });
});

// ---------------------------------------------------------------------------
// Search matching
// ---------------------------------------------------------------------------

describe('treeHasMatchingDescendant', () => {
  it('returns true when a descendant topic matches', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP', topic: 'Parent chat' }),
      makeSession({ id: 'sC', taskId: 'tC', topic: 'Fix login bug' }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(treeHasMatchingDescendant(roots[0]!, 'login', tasks)).toBe(true);
    expect(treeHasMatchingDescendant(roots[0]!, 'nomatch', tasks)).toBe(false);
  });

  it('matches on task title too', () => {
    const tasks = new Map<string, TaskInfo>([
      ['tP', makeTaskInfo({ id: 'tP', parentTaskId: null })],
      ['tC', makeTaskInfo({ id: 'tC', parentTaskId: 'tP', title: 'Refactor auth module' })],
    ]);
    const sessions = [
      makeSession({ id: 'sP', taskId: 'tP', topic: 'Parent' }),
      makeSession({ id: 'sC', taskId: 'tC', topic: 'Some chat' }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(treeHasMatchingDescendant(roots[0]!, 'auth', tasks)).toBe(true);
  });

  it('searches recursively through deep descendants', () => {
    const tasks = new Map<string, TaskInfo>([
      ['t1', makeTaskInfo({ id: 't1', parentTaskId: null })],
      ['t2', makeTaskInfo({ id: 't2', parentTaskId: 't1' })],
      ['t3', makeTaskInfo({ id: 't3', parentTaskId: 't2' })],
    ]);
    const sessions = [
      makeSession({ id: 's1', taskId: 't1', topic: 'Top' }),
      makeSession({ id: 's2', taskId: 't2', topic: 'Middle' }),
      makeSession({ id: 's3', taskId: 't3', topic: 'Deep match here' }),
    ];
    const roots = buildSessionTree(sessions, tasks);
    expect(treeHasMatchingDescendant(roots[0]!, 'match', tasks)).toBe(true);
  });
});
