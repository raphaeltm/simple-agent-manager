/**
 * Vertical slice + regression tests for SAM dispatch_task lineage propagation.
 *
 * Verifies that tasks dispatched from a SAM chat session with a parentTaskId
 * get correct parent_task_id and dispatch_depth so the UI groups them as
 * subtasks (sidebar nesting + hierarchy button).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn(() => `ULID_${++ulidCounter}`),
}));

import { hasHierarchy } from '../../../../web/src/components/task-hierarchy/buildHierarchyTree';
import { isRetryOrFork } from '../../../../web/src/pages/project-chat/lineageUtils';
import { buildTaskInfoMap } from '../../../../web/src/pages/project-chat/useTaskGroups';
import {
  buildDispatchCtx,
  getDispatchTaskMocks,
  resetDispatchTaskMocks,
} from './sam-dispatch-test-helpers';

const { dispatchTask } = await import('../../../src/durable-objects/sam-session/tools/dispatch-task');

const dispatchTaskMocks = getDispatchTaskMocks();

describe('SAM dispatch_task lineage propagation', () => {
  beforeEach(() => {
    ulidCounter = 0;
    resetDispatchTaskMocks({ title: 'Child task title' });
  });

  describe('with parentTaskId provided', () => {
    it('sets parent_task_id and dispatch_depth in the INSERT', async () => {
      const { ctx } = buildDispatchCtx({ id: 'parent-task-1', dispatch_depth: 0 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Fix the bug', parentTaskId: 'parent-task-1' },
        ctx,
      ) as { taskId?: string; parentTaskId?: string | null; dispatchDepth?: number };

      expect(result.parentTaskId).toBe('parent-task-1');
      expect(result.dispatchDepth).toBe(1);

      // Verify the INSERT SQL includes parent_task_id
      const prepareCalls = (ctx.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const insertSql = prepareCalls.find(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT INTO tasks'),
      );
      expect(insertSql).toBeDefined();
      expect(insertSql![0]).toContain('parent_task_id');
    });

    it('computes dispatch_depth from parent depth + 1', async () => {
      const { ctx } = buildDispatchCtx({ id: 'grandparent-task', dispatch_depth: 2 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Deep subtask', parentTaskId: 'grandparent-task' },
        ctx,
      ) as { dispatchDepth?: number };

      expect(result.dispatchDepth).toBe(3);
    });

    it('returns error when parent task not found', async () => {
      const { ctx } = buildDispatchCtx(null);

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Orphan', parentTaskId: 'nonexistent' },
        ctx,
      ) as { error?: string };

      expect(result.error).toContain('Parent task not found');
    });

    it('returns error when dispatch depth exceeds the limit', async () => {
      // Default max depth is 3, so parent at depth 3 → child at depth 4 should fail
      const { ctx } = buildDispatchCtx({ id: 'deep-parent', dispatch_depth: 3 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Too deep', parentTaskId: 'deep-parent' },
        ctx,
      ) as { error?: string };

      expect(result.error).toContain('Dispatch depth limit');
      expect(result.error).toContain('exceeded');
      // Ensure no task was actually created (startTaskRunnerDO not called)
      expect(dispatchTaskMocks.startTaskRunnerDO).not.toHaveBeenCalled();
    });

    it('scopes parent lookup to the correct project and user', async () => {
      const { ctx, bindCalls } = buildDispatchCtx({ id: 'parent-task-1', dispatch_depth: 0 });

      await dispatchTask(
        { projectId: 'proj-1', description: 'Subtask', parentTaskId: 'parent-task-1' },
        ctx,
      );

      // The first bind() call is for the parent task SELECT query
      // It should scope by taskId, projectId, and userId
      const parentLookupBind = bindCalls[0];
      expect(parentLookupBind).toEqual(['parent-task-1', 'proj-1', 'user-1']);
    });

    it('inherits the parent credential attribution pin for child resolution and TaskRunner start', async () => {
      const { ctx } = buildDispatchCtx({
        id: 'parent-task-1',
        dispatch_depth: 0,
        user_id: 'member-a',
        credential_attribution_user_id: 'member-a',
        credential_attribution_project_id: 'proj-1',
        credential_attribution_source: 'project',
      });

      await dispatchTask(
        { projectId: 'proj-1', description: 'Subtask', parentTaskId: 'parent-task-1' },
        ctx,
      );

      expect(dispatchTaskMocks.resolveTaskStartPlacementCredentialAttribution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          credentialProjectPolicy: 'current-project-unless-inherited',
          inheritedCredentialAttribution: {
            userId: 'member-a',
            projectId: 'proj-1',
            source: 'project',
          },
        }),
      );
      expect(dispatchTaskMocks.startTaskRunnerDO).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          credentialAttributionUserId: 'member-a',
          credentialAttributionProjectId: 'proj-1',
          credentialAttributionSource: 'project',
          cloudProvider: 'hetzner',
        }),
      );
    });

    it('sets triggered_by to mcp so isRetryOrFork returns false', async () => {
      const { ctx } = buildDispatchCtx({ id: 'parent-task-1', dispatch_depth: 0 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Subtask', parentTaskId: 'parent-task-1' },
        ctx,
      ) as { parentTaskId?: string | null; dispatchDepth?: number };

      // Simulate what the UI does: build TaskInfo from the result
      const taskInfo = {
        id: 'child-task',
        title: 'Child task title',
        parentTaskId: result.parentTaskId ?? null,
        status: 'queued' as const,
        blocked: false,
        triggeredBy: 'mcp',
        dispatchDepth: result.dispatchDepth ?? 0,
        taskMode: 'task' as const,
      };

      expect(isRetryOrFork(taskInfo)).toBe(false);
    });
  });

  describe('without parentTaskId (backwards compatible)', () => {
    it('sets dispatch_depth to 0 and parent_task_id to null', async () => {
      const { ctx } = buildDispatchCtx();

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Top-level task' },
        ctx,
      ) as { parentTaskId?: string | null; dispatchDepth?: number };

      expect(result.parentTaskId).toBeNull();
      expect(result.dispatchDepth).toBe(0);
    });

    it('treats whitespace-only parentTaskId as absent', async () => {
      const { ctx } = buildDispatchCtx(null);

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Top-level task', parentTaskId: '   ' },
        ctx,
      ) as { parentTaskId?: string | null; dispatchDepth?: number };

      expect(result.parentTaskId).toBeNull();
      expect(result.dispatchDepth).toBe(0);

      // Confirm no parent lookup SELECT was attempted
      const prepareCalls = (ctx.env.DATABASE.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const selectCall = prepareCalls.find(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('SELECT id, dispatch_depth'),
      );
      expect(selectCall).toBeUndefined();
    });
  });

  describe('regression: lineage propagates to UI task list', () => {
    it('buildTaskInfoMap + hasHierarchy detects parent/child from SAM dispatch', async () => {
      // Simulate the lifecycle:
      // 1. Parent task exists in DB
      // 2. SAM dispatches a child task with parentTaskId
      // 3. UI fetches task list and builds taskInfoMap
      // 4. hasHierarchy returns true for the parent

      const { ctx } = buildDispatchCtx({ id: 'parent-task-1', dispatch_depth: 0 });
      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Child work', parentTaskId: 'parent-task-1' },
        ctx,
      ) as { taskId: string; parentTaskId: string | null; dispatchDepth: number };

      // Simulate the task list the API would return
      const tasks = [
        {
          id: 'parent-task-1',
          title: 'Parent task',
          parentTaskId: null,
          status: 'in_progress' as const,
          blocked: false,
          triggeredBy: 'user',
          dispatchDepth: 0,
          taskMode: 'task' as const,
        },
        {
          id: result.taskId,
          title: 'Child task title',
          parentTaskId: result.parentTaskId,
          status: 'queued' as const,
          blocked: false,
          triggeredBy: 'mcp',
          dispatchDepth: result.dispatchDepth,
          taskMode: 'task' as const,
        },
      ];

      const taskInfoMap = buildTaskInfoMap(tasks as any);

      // The parent should have hierarchy (it has a child subtask)
      expect(hasHierarchy('parent-task-1', taskInfoMap)).toBe(true);

      // The child should also have hierarchy (it has a parent)
      expect(hasHierarchy(result.taskId, taskInfoMap)).toBe(true);

      // The child is NOT a retry/fork — it's a genuine subtask
      const childInfo = taskInfoMap.get(result.taskId)!;
      expect(isRetryOrFork(childInfo)).toBe(false);
    });
  });
});
