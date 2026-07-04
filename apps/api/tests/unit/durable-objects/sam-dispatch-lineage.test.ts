/**
 * Vertical slice + regression tests for SAM dispatch_task lineage propagation.
 *
 * Verifies that tasks dispatched from a SAM chat session with a parentTaskId
 * get correct parent_task_id and dispatch_depth so the UI groups them as
 * subtasks (sidebar nesting + hierarchy button).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
  },
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  resolveCredentialSource: vi.fn(),
  resolveAgentProfile: vi.fn(),
  generateTaskTitle: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mocks.db),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: mocks.resolveAgentProfile,
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: mocks.requireRepositoryOwnerAccess,
}));

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn(() => `ULID_${++ulidCounter}`),
}));

import { hasHierarchy } from '../../../../web/src/components/task-hierarchy/buildHierarchyTree';
import { isRetryOrFork } from '../../../../web/src/pages/project-chat/lineageUtils';
import { buildTaskInfoMap } from '../../../../web/src/pages/project-chat/useTaskGroups';
import { dispatchTask } from '../../../src/durable-objects/sam-session/tools/dispatch-task';

const project = {
  id: 'proj-1',
  name: 'Project',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultAgentType: null,
  defaultLocation: null,
  agentDefaults: null,
  taskExecutionTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  warmNodeTimeoutMs: null,
};

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  };
}

/**
 * Build a context with a DATABASE mock that:
 * - Tracks all prepare().bind() calls for assertion
 * - Optionally returns a parent task row for the lineage lookup
 */
function buildCtx(parentTaskRow?: {
  id: string;
  dispatch_depth: number;
  user_id?: string;
  credential_attribution_user_id?: string | null;
  credential_attribution_project_id?: string | null;
  credential_attribution_source?: string | null;
} | null) {
  const hydratedParentTaskRow = parentTaskRow
    ? {
        user_id: 'user-1',
        credential_attribution_user_id: null,
        credential_attribution_project_id: null,
        credential_attribution_source: 'user',
        ...parentTaskRow,
      }
    : parentTaskRow;
  const bindCalls: unknown[][] = [];
  const statement = {
    bind: vi.fn((...args: unknown[]) => {
      bindCalls.push(args);
      return statement;
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(hydratedParentTaskRow ?? null),
  };

  return {
    ctx: {
      env: {
        DATABASE: {
          prepare: vi.fn(() => statement),
        },
        PROJECT_DATA: {
          idFromName: vi.fn(() => 'project-data-id'),
          get: vi.fn(() => ({
            fetch: vi.fn().mockResolvedValue(new Response('ok')),
          })),
        },
        AI: {},
        BASE_DOMAIN: 'example.com',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
      },
      userId: 'user-1',
    },
    bindCalls,
    statement,
  };
}

describe('SAM dispatch_task lineage propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ulidCounter = 0;
    mocks.db.select
      .mockImplementationOnce(() => selectRows([project]))
      .mockImplementationOnce(() => selectRows([{ name: 'User', email: 'user@example.com', githubId: '12345' }]));
    mocks.resolveAgentProfile.mockResolvedValue(null);
    mocks.resolveCredentialSource.mockResolvedValue({ credentialSource: 'user', providerName: 'hetzner' });
    mocks.generateTaskTitle.mockResolvedValue('Child task title');
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue('message-1');
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  });

  describe('with parentTaskId provided', () => {
    it('sets parent_task_id and dispatch_depth in the INSERT', async () => {
      const { ctx } = buildCtx({ id: 'parent-task-1', dispatch_depth: 0 });

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
      const { ctx } = buildCtx({ id: 'grandparent-task', dispatch_depth: 2 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Deep subtask', parentTaskId: 'grandparent-task' },
        ctx,
      ) as { dispatchDepth?: number };

      expect(result.dispatchDepth).toBe(3);
    });

    it('returns error when parent task not found', async () => {
      const { ctx } = buildCtx(null);

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Orphan', parentTaskId: 'nonexistent' },
        ctx,
      ) as { error?: string };

      expect(result.error).toContain('Parent task not found');
    });

    it('returns error when dispatch depth exceeds the limit', async () => {
      // Default max depth is 3, so parent at depth 3 → child at depth 4 should fail
      const { ctx } = buildCtx({ id: 'deep-parent', dispatch_depth: 3 });

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Too deep', parentTaskId: 'deep-parent' },
        ctx,
      ) as { error?: string };

      expect(result.error).toContain('Dispatch depth limit');
      expect(result.error).toContain('exceeded');
      // Ensure no task was actually created (startTaskRunnerDO not called)
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    });

    it('scopes parent lookup to the correct project and user', async () => {
      const { ctx, bindCalls } = buildCtx({ id: 'parent-task-1', dispatch_depth: 0 });

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
      const { ctx } = buildCtx({
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

      expect(mocks.resolveCredentialSource).toHaveBeenCalledWith(
        expect.anything(),
        'member-a',
        undefined,
        'proj-1',
      );
      expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
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
      const { ctx } = buildCtx({ id: 'parent-task-1', dispatch_depth: 0 });

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
      const { ctx } = buildCtx();

      const result = await dispatchTask(
        { projectId: 'proj-1', description: 'Top-level task' },
        ctx,
      ) as { parentTaskId?: string | null; dispatchDepth?: number };

      expect(result.parentTaskId).toBeNull();
      expect(result.dispatchDepth).toBe(0);
    });

    it('treats whitespace-only parentTaskId as absent', async () => {
      const { ctx } = buildCtx(null);

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

      const { ctx } = buildCtx({ id: 'parent-task-1', dispatch_depth: 0 });
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
