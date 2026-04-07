/**
 * Tests for the inbox drain service — delivers queued messages to parent agent sessions.
 *
 * Covers: resolveParentSessionContext, drainSessionInbox, formatInboxPrompt, formatMessageType.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  drainSessionInbox,
  formatInboxPrompt,
  formatMessageType,
  resolveParentSessionContext,
} from '../../../src/services/inbox-drain';
import { sendPromptToAgentOnNode } from '../../../src/services/node-agent';

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: vi.fn(),
}));

vi.mock('../../../src/lib/route-helpers', () => ({
  parsePositiveInt: (_val: string | undefined, def: number) => def,
}));

vi.mock('../../../src/routes/mcp/_helpers', () => ({
  DEFAULT_ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE: 10,
}));

const mockedSendPrompt = vi.mocked(sendPromptToAgentOnNode);

// ─── formatMessageType ──────────────────────────────────────────────────────

describe('formatMessageType', () => {
  it('formats child_completed', () => {
    expect(formatMessageType('child_completed')).toBe('Child Task Completed');
  });

  it('formats child_failed', () => {
    expect(formatMessageType('child_failed')).toBe('Child Task Failed');
  });

  it('formats child_needs_input', () => {
    expect(formatMessageType('child_needs_input')).toBe('Child Task Needs Input');
  });

  it('formats parent_message', () => {
    expect(formatMessageType('parent_message')).toBe('Parent Message');
  });

  it('returns raw type for unknown types', () => {
    expect(formatMessageType('custom_event')).toBe('custom_event');
  });
});

// ─── formatInboxPrompt ──────────────────────────────────────────────────────

describe('formatInboxPrompt', () => {
  it('formats a single normal message', () => {
    const result = formatInboxPrompt([
      { messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done!', priority: 'normal' },
    ]);
    expect(result).toContain('[Orchestrator Notification — Child Task Completed]');
    expect(result).toContain('Done!');
    expect(result).not.toContain('URGENT');
  });

  it('formats a single urgent message', () => {
    const result = formatInboxPrompt([
      { messageType: 'child_needs_input', sourceTaskId: 'task-1', content: 'Help!', priority: 'urgent' },
    ]);
    expect(result).toContain('(URGENT)');
    expect(result).toContain('Child Task Needs Input');
    expect(result).toContain('Help!');
  });

  it('formats multiple messages with numbered headers', () => {
    const result = formatInboxPrompt([
      { messageType: 'child_completed', sourceTaskId: 'task-1', content: 'First', priority: 'normal' },
      { messageType: 'child_failed', sourceTaskId: 'task-2', content: 'Second', priority: 'urgent' },
    ]);
    expect(result).toContain('[Orchestrator: 2 pending notifications]');
    expect(result).toContain('Notification 1/2: Child Task Completed');
    expect(result).toContain('Notification 2/2: Child Task Failed (URGENT)');
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });
});

// ─── resolveParentSessionContext ─────────────────────────────────────────────

describe('resolveParentSessionContext', () => {
  function createMockDb(row: Record<string, unknown> | null) {
    return {
      prepare: () => ({
        bind: () => ({
          first: vi.fn().mockResolvedValue(row),
        }),
      }),
    } as unknown as D1Database;
  }

  it('returns context when all fields are present', async () => {
    const db = createMockDb({
      project_id: 'proj-1',
      user_id: 'user-1',
      workspace_id: 'ws-1',
      chat_session_id: 'sess-1',
      node_id: 'node-1',
    });
    const result = await resolveParentSessionContext(db, 'parent-task-1');
    expect(result).toEqual({
      parentProjectId: 'proj-1',
      parentWorkspaceId: 'ws-1',
      parentChatSessionId: 'sess-1',
      parentNodeId: 'node-1',
      parentUserId: 'user-1',
    });
  });

  it('returns null when task not found', async () => {
    const db = createMockDb(null);
    const result = await resolveParentSessionContext(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when workspace_id is null', async () => {
    const db = createMockDb({
      project_id: 'proj-1',
      user_id: 'user-1',
      workspace_id: null,
      chat_session_id: 'sess-1',
      node_id: 'node-1',
    });
    const result = await resolveParentSessionContext(db, 'task-1');
    expect(result).toBeNull();
  });

  it('returns null when chat_session_id is null', async () => {
    const db = createMockDb({
      project_id: 'proj-1',
      user_id: 'user-1',
      workspace_id: 'ws-1',
      chat_session_id: null,
      node_id: 'node-1',
    });
    const result = await resolveParentSessionContext(db, 'task-1');
    expect(result).toBeNull();
  });

  it('returns null when node_id is null', async () => {
    const db = createMockDb({
      project_id: 'proj-1',
      user_id: 'user-1',
      workspace_id: 'ws-1',
      chat_session_id: 'sess-1',
      node_id: null,
    });
    const result = await resolveParentSessionContext(db, 'task-1');
    expect(result).toBeNull();
  });
});

// ─── drainSessionInbox ──────────────────────────────────────────────────────

describe('drainSessionInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockEnv(options: {
    pendingMessages?: Array<{ id: string; messageType: string; sourceTaskId: string | null; content: string; priority: string }>;
    sessionRow?: { workspace_id: string; node_id: string; user_id: string } | null;
    taskRow?: { id: string } | null;
  }) {
    const markDeliveredFn = vi.fn().mockResolvedValue(options.pendingMessages?.length ?? 0);
    const getPendingFn = vi.fn().mockResolvedValue(options.pendingMessages ?? []);

    let dbCallIndex = 0;
    const dbResults = [options.sessionRow, options.taskRow];

    return {
      env: {
        ORCHESTRATOR_INBOX_DRAIN_BATCH_SIZE: undefined,
        PROJECT_DATA: {
          idFromName: vi.fn().mockReturnValue('do-id'),
          get: vi.fn().mockReturnValue({
            getPendingInboxMessages: getPendingFn,
            markInboxDelivered: markDeliveredFn,
          }),
        },
        DATABASE: {
          prepare: () => ({
            bind: () => ({
              first: vi.fn().mockImplementation(() => {
                const result = dbResults[dbCallIndex];
                dbCallIndex++;
                return Promise.resolve(result);
              }),
            }),
          }),
        },
      },
      mocks: { markDeliveredFn, getPendingFn },
    };
  }

  it('returns early when no pending messages', async () => {
    const { env } = createMockEnv({ pendingMessages: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result).toEqual({ delivered: 0, pending: 0, skipped: false });
  });

  it('returns skipped when no workspace found for session', async () => {
    const messages = [{ id: 'msg-1', messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done', priority: 'normal' }];
    const { env } = createMockEnv({ pendingMessages: messages, sessionRow: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe('no_workspace');
    expect(result.pending).toBe(1);
  });

  it('marks messages delivered and skips when parent task not active', async () => {
    const messages = [{ id: 'msg-1', messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done', priority: 'normal' }];
    const { env, mocks } = createMockEnv({
      pendingMessages: messages,
      sessionRow: { workspace_id: 'ws-1', node_id: 'node-1', user_id: 'user-1' },
      taskRow: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe('parent_not_active');
    expect(result.pending).toBe(0);
    expect(mocks.markDeliveredFn).toHaveBeenCalledWith(['msg-1']);
  });

  it('delivers messages successfully', async () => {
    const messages = [{ id: 'msg-1', messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done', priority: 'normal' }];
    const { env, mocks } = createMockEnv({
      pendingMessages: messages,
      sessionRow: { workspace_id: 'ws-1', node_id: 'node-1', user_id: 'user-1' },
      taskRow: { id: 'task-parent' },
    });
    mockedSendPrompt.mockResolvedValue(undefined as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result.delivered).toBe(1);
    expect(result.skipped).toBe(false);
    expect(mocks.markDeliveredFn).toHaveBeenCalledWith(['msg-1']);
    expect(mockedSendPrompt).toHaveBeenCalledWith(
      'node-1', 'ws-1', 'sess-1', expect.any(String), env, 'user-1',
    );
  });

  it('returns agent_busy on 409 error', async () => {
    const messages = [{ id: 'msg-1', messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done', priority: 'normal' }];
    const { env, mocks } = createMockEnv({
      pendingMessages: messages,
      sessionRow: { workspace_id: 'ws-1', node_id: 'node-1', user_id: 'user-1' },
      taskRow: { id: 'task-parent' },
    });
    mockedSendPrompt.mockRejectedValue(new Error('HTTP 409 Conflict'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe('agent_busy');
    expect(result.pending).toBe(1);
    expect(mocks.markDeliveredFn).not.toHaveBeenCalled();
  });

  it('returns error on non-409 delivery failure', async () => {
    const messages = [{ id: 'msg-1', messageType: 'child_completed', sourceTaskId: 'task-1', content: 'Done', priority: 'normal' }];
    const { env, mocks } = createMockEnv({
      pendingMessages: messages,
      sessionRow: { workspace_id: 'ws-1', node_id: 'node-1', user_id: 'user-1' },
      taskRow: { id: 'task-parent' },
    });
    mockedSendPrompt.mockRejectedValue(new Error('Connection refused'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await drainSessionInbox('proj-1', 'sess-1', env as any);
    expect(result.skipped).toBe(true);
    expect(result.error).toBe('Connection refused');
    expect(result.pending).toBe(1);
    expect(mocks.markDeliveredFn).not.toHaveBeenCalled();
  });
});
