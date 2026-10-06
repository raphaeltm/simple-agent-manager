import type { AgentMailboxMessage, MessageCommentThread } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerChatCommentDirectiveRoute } from '../../../src/routes/chat-comment-directives';

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: vi.fn(() => 'human-1'),
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn().mockResolvedValue(undefined),
}));

type ProjectDataCommentTestStub = {
  ensureProjectId: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  getCommentThread: ReturnType<typeof vi.fn>;
  updateCommentThreadStatus: ReturnType<typeof vi.fn>;
  acceptPromptDelivery: ReturnType<typeof vi.fn>;
};

function makeApp(): Hono<{ Bindings: Env }> {
  const root = new Hono<{ Bindings: Env }>();
  const routes = new Hono<{ Bindings: Env }>();
  registerChatCommentDirectiveRoute(routes);
  root.route('/api/projects/:projectId/sessions', routes);
  root.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    throw err;
  });
  return root;
}

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    status: 'open',
    anchor: {
      kind: 'message',
      messageId: 'message-1',
      quote: 'Quote from the source message',
    },
    body: 'Please address this specific comment.',
    author: {
      kind: 'human',
      id: 'reviewer-1',
      displayName: 'Reviewer',
    },
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    replyCount: 1,
    lastReplyAt: 1100,
    sourceMessage: {
      id: 'message-1',
      role: 'assistant',
      quote: 'Source message context',
      createdAt: 900,
    },
    directive: null,
    replies: [
      {
        id: 'reply-1',
        body: 'Existing reply that must not be sent passively.',
        author: { kind: 'human', id: 'reviewer-2', displayName: 'Second reviewer' },
        createdAt: 1100,
      },
    ],
    ...overrides,
  };
}

function makeMailboxMessage(id: string, duplicate: boolean): AgentMailboxMessage {
  return {
    id,
    targetSessionId: 'session-1',
    sourceTaskId: 'task-1',
    senderType: 'human',
    senderId: 'human-1',
    messageClass: 'deliver',
    deliveryState: duplicate ? 'delivered' : 'queued',
    content: 'comment directive',
    metadata: null,
    ackRequired: false,
    ackTimeoutMs: null,
    deliveryAttempts: duplicate ? 1 : 0,
    lastDeliveryAt: duplicate ? 2500 : null,
    expiresAt: null,
    createdAt: 2000,
    deliveredAt: duplicate ? 2500 : null,
    ackedAt: null,
    sourceKind: 'comment_directive',
    promptMessageId: `prompt-${id}`,
    nextAttemptAt: null,
    lastError: null,
    terminalReason: null,
    attemptId: duplicate ? 'attempt-1' : null,
    attemptStartedAt: duplicate ? 2400 : null,
    runtimeIdentity: duplicate ? 'agent-runtime-1' : null,
    receiptState: duplicate ? 'accepted' : null,
    receiptRuntimeIdentity: duplicate ? 'agent-runtime-1' : null,
    receiptCheckedAt: duplicate ? 2600 : null,
    acceptedAt: 2000,
    adapterProtocolVersion: 1,
    receiptSupported: true,
  };
}

function makeEnv(
  options: {
    duplicate?: boolean;
    session?: { id: string; taskId: string; projectId: string } | null;
    thread?: MessageCommentThread | null;
    durablePromptDeliveryEnabled?: string;
  } = {}
): Env & {
  _projectDataStub: ProjectDataCommentTestStub;
} {
  const duplicate = options.duplicate ?? false;
  const session =
    options.session === undefined
      ? { id: 'session-1', taskId: 'task-1', projectId: 'project-1' }
      : options.session;
  const thread = options.thread === undefined ? makeThread() : options.thread;
  const deliveryId = 'comment-directive-thread-1';
  const projectDataStub: ProjectDataCommentTestStub = {
    ensureProjectId: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(session),
    getCommentThread: vi.fn().mockResolvedValue(thread),
    updateCommentThreadStatus: vi.fn(async () => ({
      thread: {
        ...(thread ?? makeThread()),
        status: 'sent',
      },
      idempotent: false,
    })),
    acceptPromptDelivery: vi.fn().mockResolvedValue({
      message: makeMailboxMessage(deliveryId, duplicate),
      transcriptMessageId: `prompt-${deliveryId}`,
      transcriptInserted: !duplicate,
      transcriptCreatedAt: 2000,
      transcriptSequence: duplicate ? 0 : 1,
      workspaceId: 'workspace-1',
    }),
  };
  const doId = { toString: () => 'project-data-project-1' };
  return {
    DATABASE: { prepare: vi.fn() },
    PROJECT_DATA: {
      idFromName: vi.fn().mockReturnValue(doId),
      get: vi.fn().mockReturnValue(projectDataStub),
    },
    PROMPT_DELIVERY_TTL_MS: '3600000',
    PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS: '30000',
    PROMPT_DELIVERY_RETRY_BASE_MS: '5000',
    PROMPT_DELIVERY_RETRY_MAX_MS: '300000',
    PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM: '5',
    PROMPT_DELIVERY_MAX_ATTEMPTS: '5',
    PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS: '5000',
    PROMPT_DELIVERY_MIN_ALARM_DELAY_MS: '1000',
    DURABLE_PROMPT_DELIVERY_ENABLED: options.durablePromptDeliveryEnabled,
    MCP_COMMENT_BODY_MAX_LENGTH: '4000',
    MCP_COMMENT_QUOTE_MAX_LENGTH: '1000',
    COMMENT_DIRECTIVE_CONTEXT_MAX_LENGTH: '6000',
    _projectDataStub: projectDataStub,
  } as unknown as Env & { _projectDataStub: ProjectDataCommentTestStub };
}

describe('chat comment directive route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues one comment directive for the authenticated project session', async () => {
    const app = makeApp();
    const env = makeEnv();

    const response = await app.request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(202);
    expect(drizzle).toHaveBeenCalledWith(env.DATABASE, expect.anything());
    expect(env._projectDataStub.getSession).toHaveBeenCalledWith('session-1');
    expect(env._projectDataStub.getCommentThread).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
    });
    expect(env._projectDataStub.acceptPromptDelivery).toHaveBeenCalledWith(
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
          quote: 'Quote from the source message',
          author: { kind: 'human', displayName: 'Reviewer' },
        },
      })
    );

    const deliveryContent = env._projectDataStub.acceptPromptDelivery.mock.calls[0]?.[0]
      ?.deliveryContent as string;
    expect(deliveryContent).toContain('Comment ID: thread-1');
    expect(deliveryContent).toContain('Source message ID: message-1');
    expect(deliveryContent).not.toContain('Existing reply that must not be sent passively');

    const body = await response.json();
    expect(body).toEqual({
      accepted: true,
      status: 'queued',
      duplicate: false,
      deliveryId: 'comment-directive-thread-1',
      messageId: 'prompt-comment-directive-thread-1',
      thread: {
        id: 'thread-1',
        status: 'sent',
        directive: {
          deliveryId: 'comment-directive-thread-1',
          deliveryState: 'queued',
          promptMessageId: 'prompt-comment-directive-thread-1',
          acceptedAt: 2000,
          ackedAt: null,
        },
      },
    });
  });

  it('surfaces idempotent retries as duplicate without changing route target', async () => {
    const env = makeEnv({ duplicate: true });

    const response = await makeApp().request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(202);
    expect(env._projectDataStub.acceptPromptDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'comment-directive-thread-1' })
    );
    await expect(response.json()).resolves.toMatchObject({
      status: 'duplicate',
      duplicate: true,
      deliveryId: 'comment-directive-thread-1',
    });
  });

  it('maps a missing chat session to 404 before touching comment storage', async () => {
    const env = makeEnv({ session: null });

    const response = await makeApp().request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'NOT_FOUND',
      message: 'Chat session not found',
    });
    expect(env._projectDataStub.getSession).toHaveBeenCalledWith('session-1');
    expect(env._projectDataStub.getCommentThread).not.toHaveBeenCalled();
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('maps wrong-session comment threads to 403 without queuing delivery', async () => {
    const env = makeEnv({ thread: makeThread({ sessionId: 'session-2' }) });

    const response = await makeApp().request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'FORBIDDEN',
      message: 'Comment thread belongs to a different session',
    });
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(env._projectDataStub.updateCommentThreadStatus).not.toHaveBeenCalled();
  });

  it('maps resolved comment threads to 409 without queuing delivery', async () => {
    const env = makeEnv({ thread: makeThread({ status: 'resolved', resolvedAt: 1500 }) });

    const response = await makeApp().request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'CONFLICT',
      message: 'Resolved comment threads cannot be sent',
    });
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(env._projectDataStub.updateCommentThreadStatus).not.toHaveBeenCalled();
  });

  it('maps disabled durable delivery to 409 without false queued success', async () => {
    const env = makeEnv({ durablePromptDeliveryEnabled: 'false' });

    const response = await makeApp().request(
      '/api/projects/project-1/sessions/session-1/comments/thread-1/send-to-agent',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'CONFLICT',
      message: 'Durable prompt delivery is disabled for comment directives',
    });
    expect(env._projectDataStub.getCommentThread).not.toHaveBeenCalled();
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(env._projectDataStub.updateCommentThreadStatus).not.toHaveBeenCalled();
  });
});
