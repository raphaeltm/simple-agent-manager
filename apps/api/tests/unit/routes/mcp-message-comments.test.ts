import type {
  MessageCommentThread,
  MessageCommentThreadSummary,
} from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';
import {
  handleCreateMessageCommentThread,
  handleGetMessageCommentThread,
  handleListMessageCommentThreads,
  handleReopenMessageCommentThread,
  handleReplyToMessageCommentThread,
  handleResolveMessageCommentThread,
} from '../../../src/routes/mcp/comment-tools';
import {
  MessageCommentServiceError,
  type MessageCommentStorageAdapter,
} from '../../../src/services/message-comments';

function makeToken(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    chatSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

function makeEnv(
  overrides: Partial<Env> & {
    lookedUpSessionId?: string | null;
  } = {}
): Env & {
  DATABASE: D1Database & {
    _statement: { bind: ReturnType<typeof vi.fn>; first: ReturnType<typeof vi.fn> };
  };
} {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi
      .fn()
      .mockResolvedValue({ chat_session_id: overrides.lookedUpSessionId ?? 'session-1' }),
  };
  return {
    MCP_COMMENT_LIST_LIMIT: '5',
    MCP_COMMENT_LIST_MAX: '25',
    MCP_COMMENT_BODY_MAX_LENGTH: '4000',
    MCP_COMMENT_QUOTE_MAX_LENGTH: '1000',
    COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH: '6000',
    DATABASE: {
      prepare: vi.fn().mockReturnValue(statement),
      _statement: statement,
    },
    ...overrides,
  } as unknown as Env & {
    DATABASE: D1Database & {
      _statement: { bind: ReturnType<typeof vi.fn>; first: ReturnType<typeof vi.fn> };
    };
  };
}

function makeSummary(
  overrides: Partial<MessageCommentThreadSummary> = {}
): MessageCommentThreadSummary {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    status: 'open',
    anchor: {
      kind: 'message',
      messageId: 'message-1',
      quote: 'Original quoted context',
    },
    body: 'Please address this feedback',
    author: {
      kind: 'human',
      id: 'user-2',
      displayName: 'Reviewer',
    },
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    sourceMessage: {
      id: 'message-1',
      role: 'assistant',
      quote: 'Assistant source quote',
      createdAt: 900,
    },
    directive: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    ...makeSummary(overrides),
    replies: [],
    ...overrides,
  };
}

function makeStorage(
  overrides: Partial<MessageCommentStorageAdapter> = {}
): MessageCommentStorageAdapter {
  return {
    listThreads: vi.fn().mockResolvedValue({
      threads: [makeSummary()],
      nextCursor: null,
      hasMore: false,
    }),
    getThread: vi.fn().mockResolvedValue(makeThread()),
    createThread: vi
      .fn()
      .mockResolvedValue(
        makeThread({ author: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' } })
      ),
    replyToThread: vi.fn().mockResolvedValue(
      makeThread({
        replies: [
          {
            id: 'reply-1',
            body: 'Agent reply',
            author: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
            createdAt: 1200,
          },
        ],
      })
    ),
    updateThreadStatus: vi.fn().mockImplementation(async (input) =>
      makeThread({
        status: input.status,
        resolvedAt: input.status === 'resolved' ? 1300 : null,
      })
    ),
    markThreadObserved: vi.fn().mockResolvedValue({ observed: true }),
    recordDirectiveDelivery: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function parseToolResponse(response: JsonRpcResponse): unknown {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as unknown;
}

describe('MCP message comment tools', () => {
  it('lists current-session threads with bounded pagination input', async () => {
    const env = makeEnv({ MCP_COMMENT_LIST_LIMIT: '1', MCP_COMMENT_LIST_MAX: '2' });
    const storage = makeStorage({
      listThreads: vi.fn().mockResolvedValue({
        threads: [makeSummary(), makeSummary({ id: 'thread-2' })],
        nextCursor: 'cursor-2',
        hasMore: true,
      }),
    });

    const response = await handleListMessageCommentThreads(
      1,
      { status: 'all', limit: 99, cursor: 'cursor-1', messageId: 'message-1' },
      makeToken(),
      env,
      storage
    );

    expect(response.error).toBeUndefined();
    expect(storage.listThreads).toHaveBeenCalledWith('project-1', {
      sessionId: 'session-1',
      status: 'all',
      messageId: 'message-1',
      cursor: 'cursor-1',
      limit: 2,
    });
    expect(parseToolResponse(response)).toMatchObject({
      threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
      nextCursor: 'cursor-2',
      hasMore: true,
    });
  });

  it('returns an empty list without dumping context', async () => {
    const storage = makeStorage({
      listThreads: vi.fn().mockResolvedValue({ threads: [], nextCursor: null, hasMore: false }),
    });

    const response = await handleListMessageCommentThreads(1, {}, makeToken(), makeEnv(), storage);

    expect(response.error).toBeUndefined();
    expect(parseToolResponse(response)).toEqual({
      threads: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('rejects cross-session tool arguments before storage access', async () => {
    const storage = makeStorage();

    const response = await handleListMessageCommentThreads(
      1,
      { sessionId: 'session-2' },
      makeToken(),
      makeEnv(),
      storage
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('sessionId must match');
    expect(storage.listThreads).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied identity and project fields', async () => {
    const response = await handleCreateMessageCommentThread(
      1,
      {
        messageId: 'message-1',
        body: 'feedback',
        projectId: 'project-2',
        author: { kind: 'human', id: 'spoofed' },
      },
      makeToken(),
      makeEnv(),
      makeStorage()
    );

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain('projectId is derived');
  });

  it('resolves the current session from a workspace using the token project fence', async () => {
    const env = makeEnv({ lookedUpSessionId: 'session-from-workspace' });
    const storage = makeStorage();

    await handleListMessageCommentThreads(
      1,
      {},
      makeToken({ chatSessionId: undefined }),
      env,
      storage
    );

    expect(env.DATABASE.prepare).toHaveBeenCalledWith(
      'SELECT chat_session_id FROM workspaces WHERE id = ? AND project_id = ?'
    );
    expect(env.DATABASE._statement.bind).toHaveBeenCalledWith('workspace-1', 'project-1');
    expect(storage.listThreads).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ sessionId: 'session-from-workspace' })
    );
  });

  it('marks inspected threads observed with agent provenance', async () => {
    const storage = makeStorage();

    const response = await handleGetMessageCommentThread(
      1,
      { threadId: 'thread-1' },
      makeToken(),
      makeEnv(),
      storage
    );

    expect(response.error).toBeUndefined();
    expect(storage.markThreadObserved).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      observer: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
      provenance: {
        projectId: 'project-1',
        userId: 'user-1',
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        agentSessionId: 'agent-session-1',
      },
    });
    expect(parseToolResponse(response)).toMatchObject({ thread: { id: 'thread-1' } });
  });

  it('creates and replies with token-derived agent provenance', async () => {
    const storage = makeStorage();

    await handleCreateMessageCommentThread(
      1,
      { messageId: 'message-1', quote: 'token=secret-value-123', body: 'Use the safer path' },
      makeToken(),
      makeEnv(),
      storage
    );
    await handleReplyToMessageCommentThread(
      2,
      { threadId: 'thread-1', body: 'I addressed it' },
      makeToken(),
      makeEnv(),
      storage
    );

    expect(storage.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        quote: 'token=[redacted]',
        body: 'Use the safer path',
        author: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
      })
    );
    expect(storage.replyToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        body: 'I addressed it',
        author: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
      })
    );
  });

  it('resolves and reopens threads through the scoped status contract', async () => {
    const storage = makeStorage();

    await handleResolveMessageCommentThread(
      1,
      { threadId: 'thread-1' },
      makeToken(),
      makeEnv(),
      storage
    );
    await handleReopenMessageCommentThread(
      2,
      { threadId: 'thread-1' },
      makeToken(),
      makeEnv(),
      storage
    );

    expect(storage.updateThreadStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: 'resolved',
        projectId: 'project-1',
        sessionId: 'session-1',
      })
    );
    expect(storage.updateThreadStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'open', projectId: 'project-1', sessionId: 'session-1' })
    );
  });

  it('returns deterministic safe errors for backend gaps and unexpected failures', async () => {
    const unavailableResponse = await handleListMessageCommentThreads(
      1,
      {},
      makeToken(),
      makeEnv(),
      makeStorage({
        listThreads: vi
          .fn()
          .mockRejectedValue(
            new MessageCommentServiceError('unavailable', 'Comment storage backend is unavailable')
          ),
      })
    );
    const unexpectedResponse = await handleListMessageCommentThreads(
      2,
      {},
      makeToken(),
      makeEnv(),
      makeStorage({
        listThreads: vi.fn().mockRejectedValue(new Error('raw backend stack with token=leak')),
      })
    );

    expect(unavailableResponse.error).toEqual({
      code: -32603,
      message: 'Comment storage backend is unavailable',
    });
    expect(unexpectedResponse.error).toEqual({
      code: -32603,
      message: 'Comment tool failed',
    });
  });
});
