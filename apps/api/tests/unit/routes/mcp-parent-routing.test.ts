/**
 * Tests for request_human_input parent routing and get_inbox_status MCP tool.
 *
 * Verifies:
 * 1. Child with active parent → message enqueued to parent inbox + human notification sent
 * 2. Child without parent → human notification only
 * 3. Child with completed parent → human notification only
 * 4. Urgent priority on enqueued message
 * 5. Dual notification content includes "also sent to parent" note
 * 6. Parent resolution failure → graceful fallback to human-only
 * 7. Kill switch disabled → human notification only
 * 8. get_inbox_status returns correct counts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleRequestHumanInput } from '../../../src/routes/mcp/instruction-tools';
import { handleGetInboxStatus } from '../../../src/routes/mcp/orchestration-tools';

const tokenData: McpTokenData = {
  taskId: 'child-task-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  createdAt: '2026-04-07T00:00:00Z',
};

/**
 * Create a mock D1 that matches queries by SQL substring and returns configured results.
 */
function createQueryMatchingD1(queryMap: Record<string, unknown>) {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          for (const [pattern, result] of Object.entries(queryMap)) {
            if (sql.includes(pattern)) return result;
          }
          return null;
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        raw: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      return stmt;
    }),
  };
}

function createMockEnv(
  d1QueryMap: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const mockDoStub = {
    enqueueInboxMessage: vi.fn().mockResolvedValue('msg-1'),
    getInboxStats: vi.fn().mockResolvedValue({ pending: 0, urgentCount: 0, oldestMessageAgeMs: null }),
  };
  const mockProjectData = {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue(mockDoStub),
  };
  const mockNotificationStub = {
    createNotification: vi.fn().mockResolvedValue({ id: 'notif-1', type: 'needs_input' }),
  };
  const mockNotification = {
    idFromName: vi.fn().mockReturnValue('notif-do-id'),
    get: vi.fn().mockReturnValue(mockNotificationStub),
  };

  return {
    env: {
      DATABASE: createQueryMatchingD1(d1QueryMap),
      PROJECT_DATA: mockProjectData,
      NOTIFICATION: mockNotification,
      BASE_DOMAIN: 'example.com',
      ...overrides,
    },
    mockDoStub,
    mockProjectData,
    mockNotificationStub,
  };
}

/** Standard query map for a child task with an active parent. */
function parentRoutingQueries(opts: {
  parentTaskId?: string | null;
  parentStatus?: string;
  parentTitle?: string;
  parentWorkspaceId?: string | null;
  parentChatSessionId?: string | null;
  parentNodeId?: string | null;
  parentUserId?: string;
} = {}) {
  const {
    parentTaskId = 'parent-task-1',
    parentStatus = 'in_progress',
    parentTitle = 'Parent Task',
    parentWorkspaceId = 'ws-parent',
    parentChatSessionId = 'session-parent',
    parentNodeId = 'node-parent',
    parentUserId = 'user-1',
  } = opts;

  return {
    // Task lookup (merged): SELECT user_id, title, parent_task_id FROM tasks WHERE id = ? AND project_id = ?
    'SELECT user_id, title, parent_task_id FROM tasks': { user_id: 'user-1', title: 'Child Task', parent_task_id: parentTaskId },
    // Parent status+title: SELECT status, title FROM tasks WHERE id = ?
    'SELECT status, title FROM tasks': parentTaskId
      ? { status: parentStatus, title: parentTitle }
      : null,
    // resolveParentSessionContext: SELECT t.project_id, t.user_id, w.id ...
    'SELECT t.project_id': parentTaskId && parentWorkspaceId
      ? {
          project_id: 'proj-1',
          user_id: parentUserId,
          workspace_id: parentWorkspaceId,
          chat_session_id: parentChatSessionId,
          node_id: parentNodeId,
        }
      : null,
    // Notification: project name
    'SELECT name FROM projects': { name: 'Test Project' },
    // Notification: chat session id from workspace
    'SELECT chat_session_id FROM workspaces': { chat_session_id: 'session-child' },
  };
}

describe('handleRequestHumanInput — parent routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should enqueue urgent message to parent inbox when child has active parent', async () => {
    const { env, mockDoStub } = createMockEnv(parentRoutingQueries());

    const result = await handleRequestHumanInput(
      1,
      { context: 'Need help with deployment' },
      tokenData,
      env as any,
    );

    // Should have enqueued message to parent inbox
    expect(mockDoStub.enqueueInboxMessage).toHaveBeenCalledTimes(1);
    const enqueueCall = mockDoStub.enqueueInboxMessage.mock.calls[0]!;
    expect(enqueueCall[0]).toMatchObject({
      targetSessionId: 'session-parent',
      sourceTaskId: 'child-task-1',
      messageType: 'child_needs_input',
      priority: 'urgent',
    });
    expect(enqueueCall[0].content).toContain('Need help with deployment');
    expect(enqueueCall[0].content).toContain('send_message_to_subtask');

    // Should return success
    const body = result as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('Human input request sent');
  });

  it('should send human notification only when child has no parent', async () => {
    const { env, mockDoStub } = createMockEnv(
      parentRoutingQueries({ parentTaskId: null }),
    );

    await handleRequestHumanInput(
      1,
      { context: 'Need help' },
      tokenData,
      env as any,
    );

    // Should NOT enqueue to parent inbox
    expect(mockDoStub.enqueueInboxMessage).not.toHaveBeenCalled();
  });

  it('should send human notification only when parent is completed', async () => {
    const { env, mockDoStub } = createMockEnv(
      parentRoutingQueries({ parentStatus: 'completed' }),
    );

    await handleRequestHumanInput(
      1,
      { context: 'Need help' },
      tokenData,
      env as any,
    );

    // Should NOT enqueue because parent is not active
    expect(mockDoStub.enqueueInboxMessage).not.toHaveBeenCalled();
  });

  it('should include "also sent to parent" note in human notification when parent routed', async () => {
    const { env, mockNotificationStub } = createMockEnv(
      parentRoutingQueries({ parentTitle: 'My Parent Task' }),
    );

    await handleRequestHumanInput(
      1,
      { context: 'Need decision on architecture' },
      tokenData,
      env as any,
    );

    // The notification stub receives (userId, notification) via the DO
    expect(mockNotificationStub.createNotification).toHaveBeenCalled();
    const notifCall = mockNotificationStub.createNotification.mock.calls[0]![1] as Record<string, unknown>;
    const body = notifCall['body'] as string;
    expect(body).toContain('Also sent to parent agent task');
    expect(body).toContain('My Parent Task');
  });

  it('should skip parent routing when kill switch is disabled', async () => {
    const { env, mockDoStub } = createMockEnv(
      parentRoutingQueries(),
      { ORCHESTRATOR_PARENT_ROUTING_ENABLED: 'false' },
    );

    await handleRequestHumanInput(
      1,
      { context: 'Need help' },
      tokenData,
      env as any,
    );

    // Should NOT enqueue because routing is disabled
    expect(mockDoStub.enqueueInboxMessage).not.toHaveBeenCalled();
  });

  it('should gracefully fallback when parent has no session', async () => {
    const { env, mockDoStub } = createMockEnv(
      parentRoutingQueries({
        parentWorkspaceId: null,
        parentChatSessionId: null,
      }),
    );

    const result = await handleRequestHumanInput(
      1,
      { context: 'Need help' },
      tokenData,
      env as any,
    );

    // Should NOT enqueue because parent has no session
    expect(mockDoStub.enqueueInboxMessage).not.toHaveBeenCalled();

    // Should still return success (human notification fallback)
    const body = result as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toContain('Human input request sent');
  });

  it('should not include parent note when enqueue fails', async () => {
    const { env, mockDoStub, mockNotificationStub } = createMockEnv(
      parentRoutingQueries(),
    );

    // Make enqueueInboxMessage throw
    mockDoStub.enqueueInboxMessage.mockRejectedValue(new Error('DO unavailable'));

    await handleRequestHumanInput(
      1,
      { context: 'Need help' },
      tokenData,
      env as any,
    );

    // Notification should NOT contain parent note since routing failed
    if (mockNotificationStub.createNotification.mock.calls.length > 0) {
      const notifCall = mockNotificationStub.createNotification.mock.calls[0]![1] as Record<string, unknown>;
      const body = notifCall['body'] as string;
      expect(body).not.toContain('Also sent to parent agent task');
    }
  });
});

describe('handleGetInboxStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return inbox stats for the caller session', async () => {
    const mockDoStub = {
      getInboxStats: vi.fn().mockResolvedValue({
        pending: 3,
        urgentCount: 1,
        oldestMessageAgeMs: 5000,
      }),
    };
    const mockProjectData = {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(mockDoStub),
    };

    const db = createQueryMatchingD1({
      'SELECT chat_session_id FROM workspaces': { chat_session_id: 'session-1' },
    });

    const result = await handleGetInboxStatus(
      1,
      tokenData,
      { DATABASE: db, PROJECT_DATA: mockProjectData } as any,
    );

    const body = result as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text);
    expect(parsed.pendingCount).toBe(3);
    expect(parsed.urgentCount).toBe(1);
    expect(parsed.oldestMessageAgeMs).toBe(5000);
  });

  it('should return error when workspace has no session', async () => {
    const db = createQueryMatchingD1({
      'SELECT chat_session_id FROM workspaces': null,
    });

    const result = await handleGetInboxStatus(
      1,
      tokenData,
      { DATABASE: db, PROJECT_DATA: {} } as any,
    );

    const body = result as { error: { message: string } };
    expect(body.error.message).toContain('No active session');
  });
});
