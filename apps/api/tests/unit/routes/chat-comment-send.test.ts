import type { AgentMailboxMessage, MessageCommentThread } from '@simple-agent-manager/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { chatCommentRoutes } from '../../../src/routes/chat-comments';

/**
 * "Send to agent" (`POST .../comments/:threadId/send`) is the only way a comment reaches the
 * agent, and it queues a prompt on the session owner's agent and credentials. Gap G2: it used
 * to check only project membership. These tests drive the real route and the real
 * ProjectData service over a stubbed Durable Object.
 */

const mocks = vi.hoisted(() => ({
  userId: 'human-1',
  hasProjectCapability: vi.fn(),
  requireRepositoryAccess: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ mockedDb: true })),
}));

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: vi.fn(() => mocks.userId),
  getAuth: vi.fn(() => ({
    user: { id: mocks.userId, email: `${mocks.userId}@example.com`, name: `Name ${mocks.userId}` },
  })),
}));

vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn().mockResolvedValue({
    id: 'project-1',
    repository: 'acme/app',
    repoProvider: 'github',
  }),
  hasProjectCapability: mocks.hasProjectCapability,
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryAccess: mocks.requireRepositoryAccess,
}));

type ProjectDataCommentTestStub = {
  ensureProjectId: ReturnType<typeof vi.fn>;
  getSessionAccess: ReturnType<typeof vi.fn>;
  getCommentThread: ReturnType<typeof vi.fn>;
  updateCommentThreadStatus: ReturnType<typeof vi.fn>;
  acceptPromptDelivery: ReturnType<typeof vi.fn>;
};

function makeApp(): Hono<{ Bindings: Env }> {
  const root = new Hono<{ Bindings: Env }>();
  root.route('/api/projects/:projectId/sessions', chatCommentRoutes);
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

type Access = 'owner' | 'grantee' | 'none';

function makeEnv(
  options: {
    duplicate?: boolean;
    session?: { id: string; taskId: string; projectId: string; createdByUserId: string } | null;
    thread?: MessageCommentThread | null;
    durablePromptDeliveryEnabled?: string;
    access?: Access;
  } = {}
): Env & {
  _projectDataStub: ProjectDataCommentTestStub;
} {
  const duplicate = options.duplicate ?? false;
  const session =
    options.session === undefined
      ? { id: 'session-1', taskId: 'task-1', projectId: 'project-1', createdByUserId: 'owner-1' }
      : options.session;
  const access = options.access ?? 'owner';
  const thread = options.thread === undefined ? makeThread() : options.thread;
  const deliveryId = 'comment-directive-thread-1';
  const projectDataStub: ProjectDataCommentTestStub = {
    ensureProjectId: vi.fn().mockResolvedValue(undefined),
    getSessionAccess: vi.fn(async () => ({
      session,
      access: {
        found: Boolean(session),
        ownerUserId: session?.createdByUserId ?? null,
        sessionStatus: 'active',
        role: access,
        grant:
          access === 'grantee'
            ? {
                id: 'grant-1',
                sessionId: 'session-1',
                granteeUserId: mocks.userId,
                grantedByUserId: 'owner-1',
                parentGrantId: null,
                createdAt: 1,
              }
            : null,
      },
    })),
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

function send(env: Env) {
  return makeApp().request(
    '/api/projects/project-1/sessions/session-1/comments/thread-1/send',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    env
  );
}

describe('chat comment send-to-agent route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'owner-1';
    mocks.hasProjectCapability.mockResolvedValue(true);
    mocks.requireRepositoryAccess.mockResolvedValue(undefined);
  });

  it('queues one attributed comment directive when the session owner sends it', async () => {
    const env = makeEnv();

    const response = await send(env);

    expect(response.status).toBe(202);
    expect(env._projectDataStub.getSessionAccess).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'owner-1',
    });
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
        senderId: 'owner-1',
        messageClass: 'deliver',
        sourceKind: 'comment_directive',
        metadata: {
          commentThreadId: 'thread-1',
          sourceMessageId: 'message-1',
          quote: 'Quote from the source message',
          author: { kind: 'human', id: 'reviewer-1', displayName: 'Reviewer' },
          userId: 'owner-1',
          senderName: 'Name owner-1',
        },
      })
    );

    const deliveryContent = env._projectDataStub.acceptPromptDelivery.mock.calls[0]?.[0]
      ?.deliveryContent as string;
    expect(deliveryContent).toContain('Comment ID: thread-1');
    expect(deliveryContent).toContain('Source message ID: message-1');
    expect(deliveryContent).toContain('Author: Reviewer');
    expect(deliveryContent).toContain('Sent to you by: Name owner-1');
    expect(deliveryContent).not.toContain('shared access');
    expect(deliveryContent).not.toContain('Existing reply that must not be sent passively');
    // The owner's grant check never runs: no membership re-check, no repository check.
    expect(mocks.hasProjectCapability).not.toHaveBeenCalled();
    expect(mocks.requireRepositoryAccess).not.toHaveBeenCalled();
    // sentBy is recorded with the sender's name, not a bare id.
    expect(env._projectDataStub.updateCommentThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        actor: expect.objectContaining({ id: 'owner-1', name: 'Name owner-1' }),
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      idempotent: false,
      thread: { id: 'thread-1', status: 'sent' },
    });
  });

  it('rejects a project member who does not control the session (gap G2)', async () => {
    mocks.userId = 'reader-1';
    const env = makeEnv({ access: 'none' });

    const response = await send(env);

    expect(response.status).toBe(403);
    expect(env._projectDataStub.getCommentThread).not.toHaveBeenCalled();
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(env._projectDataStub.updateCommentThreadStatus).not.toHaveBeenCalled();
  });

  it('lets a grantee send, attributed to them and marked as shared access', async () => {
    mocks.userId = 'grantee-1';
    const env = makeEnv({ access: 'grantee' });

    const response = await send(env);

    expect(response.status).toBe(202);
    expect(mocks.hasProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'grantee-1',
      'task:write'
    );
    expect(mocks.hasProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'owner-1',
      'task:write'
    );
    // Sharing is the owner's consent; the grantee needs no repository access of their own.
    expect(mocks.requireRepositoryAccess).not.toHaveBeenCalled();
    const call = env._projectDataStub.acceptPromptDelivery.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      senderId: 'grantee-1',
      metadata: expect.objectContaining({
        userId: 'grantee-1',
        senderName: 'Name grantee-1',
        onBehalfOfUserId: 'owner-1',
        grantId: 'grant-1',
      }),
    });
    expect(call?.deliveryContent).toContain(
      'Sent to you by: Name grantee-1 (shared access to this session)'
    );
  });

  it('rejects a grantee once the session owner has left the project', async () => {
    mocks.userId = 'grantee-1';
    mocks.hasProjectCapability.mockImplementation(
      async (_db: unknown, _projectId: string, userId: string) => userId !== 'owner-1'
    );
    const env = makeEnv({ access: 'grantee' });

    const response = await send(env);

    expect(response.status).toBe(403);
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('surfaces idempotent retries as duplicate without changing route target', async () => {
    const env = makeEnv({ duplicate: true });

    const response = await send(env);

    expect(response.status).toBe(200);
    expect(env._projectDataStub.acceptPromptDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'comment-directive-thread-1' })
    );
    await expect(response.json()).resolves.toMatchObject({ idempotent: true });
  });

  it('maps a missing chat session to 404 before touching comment storage', async () => {
    const env = makeEnv({ session: null });

    const response = await send(env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'NOT_FOUND',
      message: 'Chat session not found',
    });
    expect(env._projectDataStub.getCommentThread).not.toHaveBeenCalled();
    expect(env._projectDataStub.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('maps wrong-session comment threads to 403 without queuing delivery', async () => {
    const env = makeEnv({ thread: makeThread({ sessionId: 'session-2' }) });

    const response = await send(env);

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

    const response = await send(env);

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

    const response = await send(env);

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
