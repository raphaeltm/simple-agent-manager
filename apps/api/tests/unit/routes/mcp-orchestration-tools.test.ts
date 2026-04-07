import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock KV namespace
const mockKV = {
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

/**
 * Task columns in schema definition order (matches Drizzle's SELECT * column order).
 * Drizzle D1 uses .raw() which returns arrays — values must be in this exact order.
 */
const TASK_COLUMNS = [
  'id', 'projectId', 'userId', 'parentTaskId', 'workspaceId', 'title',
  'description', 'status', 'executionStep', 'priority', 'agentProfileHint',
  'startedAt', 'completedAt', 'errorMessage', 'outputSummary', 'outputBranch',
  'outputPrUrl', 'finalizedAt', 'taskMode', 'dispatchDepth',
  'autoProvisionedNodeId', 'createdBy', 'createdAt', 'updatedAt',
] as const;

const PROJECT_COLUMNS = [
  'id', 'userId', 'name', 'repository', 'defaultBranch', 'installationId',
  'defaultVmSize', 'defaultWorkspaceProfile', 'defaultProvider', 'defaultAgentType',
  'defaultLocation', 'taskExecutionTimeoutMs', 'maxConcurrentTasks',
  'maxDispatchDepth', 'maxSubTasksPerTask', 'warmNodeTimeoutMs',
  'maxWorkspacesPerNode', 'nodeCpuThresholdPercent', 'nodeMemoryThresholdPercent',
  'createdAt', 'updatedAt',
] as const;

/** Convert a keyed object to a positional array matching a column list */
function toRawRow(columns: readonly string[], obj: Record<string, unknown>): unknown[] {
  return columns.map((col) => obj[col] ?? null);
}

/** Create a task object with sensible defaults (camelCase keys matching Drizzle column names) */
function makeTask(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'child-1',
    projectId: 'proj-456',
    userId: 'user-789',
    parentTaskId: 'parent-task-1',
    workspaceId: null,
    title: 'Child task',
    description: 'Do the thing',
    status: 'failed',
    executionStep: null,
    priority: 5,
    agentProfileHint: null,
    startedAt: null,
    completedAt: null,
    errorMessage: 'Agent crashed',
    outputSummary: null,
    outputBranch: 'sam/child-branch',
    outputPrUrl: null,
    finalizedAt: null,
    taskMode: 'task',
    dispatchDepth: 1,
    autoProvisionedNodeId: null,
    createdBy: 'user-789',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Create a project object with sensible defaults */
function makeProjectObj(): Record<string, unknown> {
  return {
    id: 'proj-456',
    userId: 'user-789',
    name: 'Test Project',
    repository: 'user/repo',
    defaultBranch: 'main',
    installationId: 'inst-1',
    defaultVmSize: null,
    defaultWorkspaceProfile: null,
    defaultProvider: null,
    defaultAgentType: null,
    defaultLocation: null,
    taskExecutionTimeoutMs: null,
    maxConcurrentTasks: null,
    maxDispatchDepth: null,
    maxSubTasksPerTask: null,
    warmNodeTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * SQL-aware D1 mock. Routes responses based on the SQL query string
 * passed to prepare(), avoiding fragile sequential mockResolvedValueOnce chains.
 */
function createMockD1() {
  type QueryHandler = {
    match: string;
    method: 'all' | 'raw' | 'first' | 'run';
    result: unknown;
    once?: boolean;
    consumed?: boolean;
  };

  const handlers: QueryHandler[] = [];
  let lastQuery = '';

  function findHandler(method: string) {
    return handlers.find(
      (h) => h.method === method && !h.consumed && lastQuery.includes(h.match),
    );
  }

  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockImplementation(() => {
      const h = findHandler('all');
      if (h?.once) h.consumed = true;
      return Promise.resolve(h ? h.result : { results: [] });
    }),
    first: vi.fn().mockImplementation(() => {
      const h = findHandler('first');
      if (h?.once) h.consumed = true;
      return Promise.resolve(h ? h.result : null);
    }),
    raw: vi.fn().mockImplementation(() => {
      const h = findHandler('raw');
      if (h?.once) h.consumed = true;
      return Promise.resolve(h ? h.result : []);
    }),
    run: vi.fn().mockImplementation(() => {
      const h = findHandler('run');
      if (h?.once) h.consumed = true;
      return Promise.resolve(h ? h.result : { success: true, meta: { changes: 1 } });
    }),
  };

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      lastQuery = sql;
      return stmt;
    }),
    batch: vi.fn(),
    _stmt: stmt,
    _handlers: handlers,
  };
}

// Mock DO namespace
const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(new Response('ok')),
  ensureProjectId: vi.fn(),
  createSession: vi.fn().mockResolvedValue('session-new'),
  stopSession: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  getSession: vi.fn().mockResolvedValue(null),
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  searchMessages: vi.fn().mockReturnValue([]),
  persistMessage: vi.fn().mockResolvedValue('msg-1'),
  linkSessionIdea: vi.fn(),
  unlinkSessionIdea: vi.fn(),
  getIdeasForSession: vi.fn().mockReturnValue([]),
  getSessionsForIdea: vi.fn().mockReturnValue([]),
  updateSessionTopic: vi.fn().mockResolvedValue(true),
};
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};

// Mock TaskRunner DO
const mockTaskRunnerStub = {
  start: vi.fn().mockResolvedValue(undefined),
};
const mockTaskRunner = {
  idFromName: vi.fn().mockReturnValue('task-runner-do-id'),
  get: vi.fn().mockReturnValue(mockTaskRunnerStub),
};

// Mock Workers AI
const mockAI = {
  run: vi.fn().mockResolvedValue({ response: 'Retry task title' }),
};

// Mock Notification DO
const mockNotificationStub = {
  createNotification: vi.fn().mockResolvedValue({ id: 'notif-1', type: 'needs_input' }),
};
const mockNotification = {
  idFromName: vi.fn().mockReturnValue('notif-do-id'),
  get: vi.fn().mockReturnValue(mockNotificationStub),
};

let mockD1 = createMockD1();
const mockEnv = {
  KV: mockKV,
  DATABASE: mockD1 as unknown,
  PROJECT_DATA: mockProjectData,
  TASK_RUNNER: mockTaskRunner,
  AI: mockAI,
  NOTIFICATION: mockNotification,
  BASE_DOMAIN: 'example.com',
};

const validTokenData = {
  taskId: 'parent-task-1',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: '2026-03-07T00:00:00Z',
};

function jsonRpcRequest(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    ...(params ? { params } : {}),
  };
}

async function mcpRequest(
  app: Hono,
  body: unknown,
  token: string = 'valid-token',
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }, mockEnv);
}

describe('MCP Orchestration Tools', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1;
    mockKV.get.mockResolvedValue(validTokenData);
    mockDoStub.createSession = vi.fn().mockResolvedValue('session-new');
    mockDoStub.persistMessage = vi.fn().mockResolvedValue('msg-1');
    const { mcpRoutes } = await import('../../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
  });

  // ─── retry_subtask ──────────────────────────────────────────────────

  describe('retry_subtask', () => {
    /** Set up all D1 mocks needed for a successful retry */
    function setupRetryHappyPath(childOverrides: Partial<Record<string, unknown>> = {}) {
      const childTask = makeTask(childOverrides);
      const project = makeProjectObj();

      // 1. Child task full select (Drizzle uses .raw() for D1)
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [toRawRow(TASK_COLUMNS, childTask)],
        once: true,
      });

      // 2. count(*) for sibling count
      mockD1._handlers.push({
        match: 'count',
        method: 'raw',
        result: [[2]],
      });

      // 3. Project full select
      mockD1._handlers.push({
        match: 'from "projects"',
        method: 'raw',
        result: [toRawRow(PROJECT_COLUMNS, project)],
      });

      // 4. User select (name, email, githubId columns)
      mockD1._handlers.push({
        match: 'from "users"',
        method: 'raw',
        result: [['User', 'user@test.com', '12345']],
      });

      // 5. Workspace query for session stop (when workspaceId is set)
      mockD1._handlers.push({
        match: 'from "workspaces"',
        method: 'raw',
        result: [['session-to-stop']],
      });

      // DO mocks
      mockDoStub.createSession = vi.fn().mockResolvedValue('sess-retry');
      mockDoStub.persistMessage = vi.fn().mockResolvedValue('msg-retry');

      return childTask;
    }

    it('should reject missing taskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'retry_subtask',
        arguments: {},
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('taskId is required');
    });

    it('should reject when child task not found', async () => {
      // Default returns empty — no handler needed
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'retry_subtask',
        arguments: { taskId: 'nonexistent' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Task not found');
    });

    it('should reject when caller is not direct parent', async () => {
      const childTask = makeTask({ parentTaskId: 'other-parent' });
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [toRawRow(TASK_COLUMNS, childTask)],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'retry_subtask',
        arguments: { taskId: 'child-1' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Only the direct parent');
    });

    it('should retry a failed child task and dispatch replacement', async () => {
      setupRetryHappyPath();

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'retry_subtask',
        arguments: { taskId: 'child-1' },
      }));

      const body = await res.json();
      expect(body.result).toBeDefined();
      const content = JSON.parse(body.result.content[0].text);
      expect(content.stoppedTaskId).toBe('child-1');
      expect(content.newTaskId).toBeDefined();
      expect(content.newSessionId).toBeDefined();
      expect(content.newBranch).toBeDefined();
    });

    it('should stop running child task before retrying', async () => {
      setupRetryHappyPath({
        id: 'child-active',
        status: 'in_progress',
        workspaceId: 'ws-child',
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'retry_subtask',
        arguments: { taskId: 'child-active', newDescription: 'Try again with fix' },
      }));

      const body = await res.json();
      expect(body.result).toBeDefined();
      const content = JSON.parse(body.result.content[0].text);
      expect(content.stoppedTaskId).toBe('child-active');
      expect(content.newTaskId).toBeDefined();
    });
  });

  // ─── add_dependency ──────────────────────────────────────────────────

  describe('add_dependency', () => {
    it('should reject missing params', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: {},
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('taskId and dependsOnTaskId are required');
    });

    it('should reject self-dependency', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-1', dependsOnTaskId: 'task-1' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('cannot depend on itself');
    });

    it('should reject when tasks not found', async () => {
      // Only 1 of the 2 tasks found
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [['task-1', 'proj-456', 'parent-task-1']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-1', dependsOnTaskId: 'task-2' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('not found');
    });

    it('should reject when caller is not parent of both tasks', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [
          ['task-1', 'proj-456', 'parent-task-1'],
          ['task-2', 'proj-456', 'other-parent'],
        ],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-1', dependsOnTaskId: 'task-2' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Caller must be the parent');
    });

    it('should add dependency between sibling tasks', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [
          ['task-a', 'proj-456', 'parent-task-1'],
          ['task-b', 'proj-456', 'parent-task-1'],
        ],
        once: true,
      });

      // Raw SQL: project edge count via first()
      mockD1._handlers.push({
        match: 'task_dependencies',
        method: 'first',
        result: { count: 5 },
      });

      // BFS: deps of dependsOnTaskId — empty = no cycle
      mockD1._handlers.push({
        match: 'from "task_dependencies"',
        method: 'raw',
        result: [],
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-a', dependsOnTaskId: 'task-b' },
      }));
      const body = await res.json();
      expect(body.result).toBeDefined();
      const content = JSON.parse(body.result.content[0].text);
      expect(content.added).toBe(true);
    });

    it('should reject cycle: A depends on B, B depends on A', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [
          ['task-a', 'proj-456', 'parent-task-1'],
          ['task-b', 'proj-456', 'parent-task-1'],
        ],
        once: true,
      });

      mockD1._handlers.push({
        match: 'task_dependencies td',
        method: 'first',
        result: { count: 5 },
      });

      // BFS from task-b: depends on task-a → creates cycle
      mockD1._handlers.push({
        match: 'from "task_dependencies"',
        method: 'raw',
        result: [['task-a']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-a', dependsOnTaskId: 'task-b' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('cycle');
    });

    it('should reject when edge limit exceeded', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [
          ['task-a', 'proj-456', 'parent-task-1'],
          ['task-b', 'proj-456', 'parent-task-1'],
        ],
        once: true,
      });

      mockD1._handlers.push({
        match: 'task_dependencies',
        method: 'first',
        result: { count: 50 },
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'add_dependency',
        arguments: { taskId: 'task-a', dependsOnTaskId: 'task-b' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('edge limit');
    });
  });

  // ─── remove_pending_subtask ─────────────────────────────────────────

  describe('remove_pending_subtask', () => {
    it('should reject missing taskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: {},
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('taskId is required');
    });

    it('should reject when task not found', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: { taskId: 'nonexistent' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Task not found');
    });

    it('should reject when caller is not parent', async () => {
      // select({id, parentTaskId, status, projectId}) → raw returns [id, parentTaskId, status, projectId]
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [['child-1', 'other-parent', 'queued', 'proj-456']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: { taskId: 'child-1' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Only the direct parent');
    });

    it('should reject non-queued (in_progress) tasks with stop suggestion', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [['child-1', 'parent-task-1', 'in_progress', 'proj-456']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: { taskId: 'child-1' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("Cannot remove task in 'in_progress' status");
      expect(body.error.message).toContain('stop_subtask');
    });

    it('should reject completed tasks', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [['child-done', 'parent-task-1', 'completed', 'proj-456']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: { taskId: 'child-done' },
      }));
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("Cannot remove task in 'completed' status");
      expect(body.error.message).toContain('already completed');
    });

    it('should cancel queued task and cleanup dependencies', async () => {
      mockD1._handlers.push({
        match: 'from "tasks"',
        method: 'raw',
        result: [['child-queued', 'parent-task-1', 'queued', 'proj-456']],
        once: true,
      });

      const res = await mcpRequest(app, jsonRpcRequest('tools/call', {
        name: 'remove_pending_subtask',
        arguments: { taskId: 'child-queued' },
      }));
      const body = await res.json();
      expect(body.result).toBeDefined();
      const content = JSON.parse(body.result.content[0].text);
      expect(content.removed).toBe(true);
      expect(content.taskId).toBe('child-queued');

      // Verify D1 operations were called (update status, insert event, delete deps)
      expect(mockD1._stmt.run).toHaveBeenCalled();
    });
  });

  // ─── tools/list ──────────────────────────────────────────────────────

  describe('tools/list', () => {
    it('should include all orchestration tools', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));
      const body = await res.json();
      const toolNames = body.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('retry_subtask');
      expect(toolNames).toContain('add_dependency');
      expect(toolNames).toContain('remove_pending_subtask');
    });

    it('retry_subtask requires taskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));
      const body = await res.json();
      const tool = body.result.tools.find((t: { name: string }) => t.name === 'retry_subtask');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.required).toContain('taskId');
    });

    it('add_dependency requires both taskId and dependsOnTaskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));
      const body = await res.json();
      const tool = body.result.tools.find((t: { name: string }) => t.name === 'add_dependency');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.required).toContain('taskId');
      expect(tool.inputSchema.required).toContain('dependsOnTaskId');
    });

    it('remove_pending_subtask requires taskId', async () => {
      const res = await mcpRequest(app, jsonRpcRequest('tools/list'));
      const body = await res.json();
      const tool = body.result.tools.find((t: { name: string }) => t.name === 'remove_pending_subtask');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.required).toContain('taskId');
    });
  });
});
