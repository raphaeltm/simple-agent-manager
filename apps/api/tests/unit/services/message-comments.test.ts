import type {
  AgentMailboxMessage,
  MessageCommentThread,
  MessageCommentThreadSummary,
} from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildCommentDirectiveDeliveryId,
  MessageCommentServiceError,
  type MessageCommentStorageAdapter,
  sendMessageCommentDirective,
} from '../../../src/services/message-comments';
import * as projectDataService from '../../../src/services/project-data';

const projectDataMocks = vi.hoisted(() => ({
  acceptPromptDelivery: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  acceptPromptDelivery: projectDataMocks.acceptPromptDelivery,
}));

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PROMPT_DELIVERY_TTL_MS: '3600000',
    PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS: '30000',
    PROMPT_DELIVERY_RETRY_BASE_MS: '5000',
    PROMPT_DELIVERY_RETRY_MAX_MS: '300000',
    PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM: '5',
    PROMPT_DELIVERY_MAX_ATTEMPTS: '5',
    PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS: '5000',
    PROMPT_DELIVERY_MIN_ALARM_DELAY_MS: '1000',
    MCP_COMMENT_BODY_MAX_LENGTH: '4000',
    MCP_COMMENT_QUOTE_MAX_LENGTH: '1000',
    COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH: '6000',
    ...overrides,
  } as unknown as Env;
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
      quote: 'Please use the project-scoped API.',
    },
    body: 'The agent should cite this feedback and avoid broad context. token=secret-value-123',
    author: {
      kind: 'human',
      id: 'user-2',
      displayName: 'Reviewer',
    },
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    replyCount: 2,
    lastReplyAt: 1200,
    sourceMessage: {
      id: 'message-1',
      role: 'assistant',
      quote: 'Longer source message context',
      createdAt: 900,
    },
    directive: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    ...makeSummary(overrides),
    replies: [
      {
        id: 'reply-1',
        body: 'This existing full-thread reply must not be injected into the directive payload.',
        author: { kind: 'human', id: 'user-3', displayName: 'Second reviewer' },
        createdAt: 1100,
      },
    ],
    ...overrides,
  };
}

function makeMailboxMessage(id: string, promptMessageId = `prompt-${id}`): AgentMailboxMessage {
  return {
    id,
    targetSessionId: 'session-1',
    sourceTaskId: 'task-1',
    senderType: 'human',
    senderId: 'human-1',
    messageClass: 'deliver',
    deliveryState: 'queued',
    content: 'directive',
    metadata: null,
    ackRequired: false,
    ackTimeoutMs: null,
    deliveryAttempts: 0,
    lastDeliveryAt: null,
    expiresAt: null,
    createdAt: 2000,
    deliveredAt: null,
    ackedAt: null,
    sourceKind: 'comment_directive',
    promptMessageId,
    nextAttemptAt: null,
    lastError: null,
    terminalReason: null,
    attemptId: null,
    attemptStartedAt: null,
    runtimeIdentity: null,
    receiptState: null,
    receiptRuntimeIdentity: null,
    receiptCheckedAt: null,
    acceptedAt: 2000,
    adapterProtocolVersion: null,
    receiptSupported: true,
  };
}

function makeAcceptedDelivery(id: string, inserted: boolean) {
  return {
    message: makeMailboxMessage(id),
    transcriptMessageId: `prompt-${id}`,
    transcriptInserted: inserted,
    transcriptCreatedAt: 2000,
    transcriptSequence: inserted ? 1 : 0,
    workspaceId: 'workspace-1',
  } satisfies Awaited<ReturnType<typeof projectDataService.acceptPromptDelivery>>;
}

function makeStorage(threads: Record<string, MessageCommentThread>): MessageCommentStorageAdapter {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(async ({ threadId }) => threads[threadId] ?? null),
    createThread: vi.fn(),
    replyToThread: vi.fn(),
    updateThreadStatus: vi.fn(),
    markThreadObserved: vi.fn(),
    recordDirectiveDelivery: vi.fn(async ({ threadId, delivery }) => {
      const thread = threads[threadId];
      return thread ? { ...thread, status: 'sent', directive: delivery } : null;
    }),
  };
}

describe('message comment directive service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a minimal comment directive through prompt delivery', async () => {
    const thread = makeThread();
    const storage = makeStorage({ 'thread-1': thread });
    projectDataMocks.acceptPromptDelivery.mockResolvedValue(
      makeAcceptedDelivery('comment-directive-thread-1', true)
    );

    const result = await sendMessageCommentDirective({
      env: makeEnv(),
      storage,
      projectId: 'project-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      humanUserId: 'human-1',
      now: 3000,
    });

    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      deliveryId: 'comment-directive-thread-1',
      messageId: 'prompt-comment-directive-thread-1',
      thread: { id: 'thread-1', status: 'sent' },
    });

    expect(projectDataService.acceptPromptDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      expect.objectContaining({
        deliveryId: 'comment-directive-thread-1',
        targetSessionId: 'session-1',
        sourceTaskId: 'task-1',
        senderType: 'human',
        senderId: 'human-1',
        messageClass: 'deliver',
        sourceKind: 'comment_directive',
        metadata: {
          commentThreadId: 'thread-1',
          sourceMessageId: 'message-1',
          quote: 'Please use the project-scoped API.',
          author: {
            kind: 'human',
            displayName: 'Reviewer',
          },
        },
      })
    );

    const deliveryInput = projectDataMocks.acceptPromptDelivery.mock.calls[0]?.[2] as {
      displayContent: string;
      deliveryContent: string;
    };
    expect(deliveryInput.deliveryContent).toBe(deliveryInput.displayContent);
    expect(deliveryInput.deliveryContent).toContain('SAM comment directive');
    expect(deliveryInput.deliveryContent).toContain('Comment ID: thread-1');
    expect(deliveryInput.deliveryContent).toContain('Source message ID: message-1');
    expect(deliveryInput.deliveryContent).toContain('Quoted context:');
    expect(deliveryInput.deliveryContent).toContain('Feedback:');
    expect(deliveryInput.deliveryContent).toContain('token=[redacted]');
    expect(deliveryInput.deliveryContent).not.toContain('full-thread reply');
    expect(storage.recordDirectiveDelivery).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      delivery: expect.objectContaining({
        deliveryId: 'comment-directive-thread-1',
        deliveryState: 'queued',
        promptMessageId: 'prompt-comment-directive-thread-1',
      }),
      sentByUserId: 'human-1',
      sentAt: 3000,
    });
  });

  it('uses a stable delivery id so browser retries are idempotent', async () => {
    const storage = makeStorage({ 'thread-1': makeThread() });
    projectDataMocks.acceptPromptDelivery
      .mockResolvedValueOnce(makeAcceptedDelivery('comment-directive-thread-1', true))
      .mockResolvedValueOnce(makeAcceptedDelivery('comment-directive-thread-1', false));

    const input = {
      env: makeEnv(),
      storage,
      projectId: 'project-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      humanUserId: 'human-1',
    };

    const first = await sendMessageCommentDirective(input);
    const second = await sendMessageCommentDirective(input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(
      projectDataMocks.acceptPromptDelivery.mock.calls.map((call) => call[2].deliveryId)
    ).toEqual([
      buildCommentDirectiveDeliveryId('thread-1'),
      buildCommentDirectiveDeliveryId('thread-1'),
    ]);
    expect(storage.recordDirectiveDelivery).toHaveBeenCalledTimes(2);
  });

  it('fails closed when durable prompt delivery is disabled', async () => {
    const storage = makeStorage({ 'thread-1': makeThread() });

    await expect(
      sendMessageCommentDirective({
        env: makeEnv({ DURABLE_PROMPT_DELIVERY_ENABLED: 'false' }),
        storage,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        humanUserId: 'human-1',
      })
    ).rejects.toMatchObject(
      new MessageCommentServiceError(
        'conflict',
        'Durable prompt delivery is disabled for comment directives'
      )
    );

    expect(projectDataMocks.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(storage.getThread).not.toHaveBeenCalled();
    expect(storage.recordDirectiveDelivery).not.toHaveBeenCalled();
  });

  it('preserves FIFO intent for concurrent distinct comment sends', async () => {
    const storage = makeStorage({
      'thread-1': makeThread({
        id: 'thread-1',
        anchor: { kind: 'message', messageId: 'message-1', quote: 'one' },
      }),
      'thread-2': makeThread({
        id: 'thread-2',
        anchor: { kind: 'message', messageId: 'message-2', quote: 'two' },
        body: 'Second feedback',
      }),
    });
    projectDataMocks.acceptPromptDelivery
      .mockResolvedValueOnce(makeAcceptedDelivery('comment-directive-thread-1', true))
      .mockResolvedValueOnce(makeAcceptedDelivery('comment-directive-thread-2', true));

    await Promise.all([
      sendMessageCommentDirective({
        env: makeEnv(),
        storage,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        humanUserId: 'human-1',
      }),
      sendMessageCommentDirective({
        env: makeEnv(),
        storage,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-2',
        humanUserId: 'human-1',
      }),
    ]);

    expect(
      projectDataMocks.acceptPromptDelivery.mock.calls.map((call) => call[2].deliveryId)
    ).toEqual(['comment-directive-thread-1', 'comment-directive-thread-2']);
    expect(
      projectDataMocks.acceptPromptDelivery.mock.calls.map((call) => call[2].sourceKind)
    ).toEqual(['comment_directive', 'comment_directive']);
    expect(
      projectDataMocks.acceptPromptDelivery.mock.calls.map((call) => call[2].messageClass)
    ).toEqual(['deliver', 'deliver']);
  });

  it('rejects missing, wrong-session, and resolved threads before delivery', async () => {
    const missing = makeStorage({});
    await expect(
      sendMessageCommentDirective({
        env: makeEnv(),
        storage: missing,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'missing',
        humanUserId: 'human-1',
      })
    ).rejects.toMatchObject(
      new MessageCommentServiceError('not_found', 'Comment thread not found')
    );

    const wrongSession = makeStorage({
      'thread-1': makeThread({ sessionId: 'session-2' }),
    });
    await expect(
      sendMessageCommentDirective({
        env: makeEnv(),
        storage: wrongSession,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        humanUserId: 'human-1',
      })
    ).rejects.toMatchObject(
      new MessageCommentServiceError('forbidden', 'Comment thread belongs to a different session')
    );

    const resolved = makeStorage({
      'thread-1': makeThread({ status: 'resolved' }),
    });
    await expect(
      sendMessageCommentDirective({
        env: makeEnv(),
        storage: resolved,
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
        humanUserId: 'human-1',
      })
    ).rejects.toMatchObject(
      new MessageCommentServiceError('conflict', 'Resolved comment threads cannot be sent')
    );

    expect(projectDataMocks.acceptPromptDelivery).not.toHaveBeenCalled();
  });
});
