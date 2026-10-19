import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

/**
 * The grantee branches of `sendChat` (apps/api/src/services/send-chat.ts): who the prompt is
 * from, what the agent is told, and the two refusals a shared session has that an owned one
 * does not. Each refusal is paired with the owner control that must still go through.
 */

const mocks = vi.hoisted(() => ({
  writer: vi.fn(),
  accept: vi.fn(),
  forward: vi.fn(),
  cancelSleep: vi.fn(),
  enrich: vi.fn(),
  users: [] as Array<{ id: string; name: string | null; email: string | null }>,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: () => ({ from: () => ({ where: async () => mocks.users }) }),
  })),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn(async () => ({ id: 'project-1' })),
}));
vi.mock('../../../src/services/session-access', () => ({
  requireSessionWriter: mocks.writer,
}));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: mocks.enrich,
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  cancelScheduledSessionSleep: mocks.cancelSleep,
}));
vi.mock('../../../src/services/project-data', () => ({ acceptPromptDelivery: mocks.accept }));
vi.mock('../../../src/routes/chat-prompt-forward', () => ({
  forwardPromptToLiveAgent: mocks.forward,
}));

const { sendChat } = await import('../../../src/services/send-chat');

const attachment = {
  uploadId: 'upload-1',
  filename: 'context.txt',
  size: 5,
  contentType: 'text/plain',
};

function writerFor(actorUserId: string) {
  const grantee = actorUserId !== 'owner-1';
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    session: { id: 'session-1' },
    role: grantee ? 'grantee' : 'owner',
    actorUserId,
    ownerUserId: 'owner-1',
    grantId: grantee ? 'grant-1' : null,
  };
}

function envWith(overrides: Record<string, unknown> = {}) {
  return {
    R2: { head: vi.fn().mockResolvedValue({ size: 5 }) },
    ...overrides,
  } as unknown as Env & {
    R2: { head: ReturnType<typeof vi.fn> };
  };
}

describe('sendChat in a shared session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.users = [
      { id: 'owner-1', name: 'Olivia Owner', email: 'olivia@example.com' },
      { id: 'grantee-1', name: 'Grace Grantee', email: 'grace@example.com' },
    ];
    mocks.writer.mockImplementation(
      async (_env: unknown, _projectId: string, _sessionId: string, userId: string) =>
        writerFor(userId)
    );
    mocks.enrich.mockImplementation(async (message: string) => ({ enrichedMessage: message }));
    mocks.accept.mockResolvedValue({
      message: { id: 'delivery-1' },
      transcriptMessageId: 'message-1',
    });
    mocks.forward.mockResolvedValue({ ok: true });
  });

  it('queues a grantee prompt as the grantee, with the speaker line only in the agent’s copy', async () => {
    const env = envWith();

    await expect(
      sendChat(env, 'grantee-1', 'project-1', 'session-1', { content: 'Please add a test' })
    ).resolves.toMatchObject({ accepted: true, deliveryId: 'delivery-1' });

    const [, projectId, input] = mocks.accept.mock.calls[0]!;
    expect(projectId).toBe('project-1');
    expect(input).toMatchObject({
      targetSessionId: 'session-1',
      senderType: 'human',
      senderId: 'grantee-1',
      sourceKind: 'user_followup',
      metadata: {
        userId: 'grantee-1',
        senderName: 'Grace Grantee',
        onBehalfOfUserId: 'owner-1',
        grantId: 'grant-1',
      },
    });
    // The transcript shows what they typed; the agent's copy names who is speaking.
    expect(input.displayContent).toBe('Please add a test');
    expect(input.deliveryContent).toBe(
      '[SAM: This message is from Grace Grantee, a project member with shared access to this ' +
        'session. Olivia Owner owns this session. Everything after this line is their message ' +
        'as typed.]\n\nPlease add a test'
    );
    // Agent-profile mentions resolve as the owner, whose identity the agent runs under.
    expect(mocks.enrich).toHaveBeenCalledWith(
      'Please add a test',
      expect.anything(),
      'project-1',
      'owner-1',
      env
    );
  });

  it('adds no speaker line and no on-behalf-of metadata to the owner’s own prompt', async () => {
    await sendChat(envWith(), 'owner-1', 'project-1', 'session-1', { content: 'Ship it' });

    const [, , input] = mocks.accept.mock.calls[0]!;
    expect(input.senderId).toBe('owner-1');
    expect(input.deliveryContent).toBe('Ship it');
    expect(input.metadata).toEqual({ userId: 'owner-1' });
  });

  it('falls back to a name from the email when a teammate has no display name', async () => {
    mocks.users = [
      { id: 'owner-1', name: '  ', email: 'olivia@example.com' },
      { id: 'grantee-1', name: null, email: 'grace@example.com' },
    ];

    await sendChat(envWith(), 'grantee-1', 'project-1', 'session-1', { content: 'Hi' });

    const [, , input] = mocks.accept.mock.calls[0]!;
    expect(input.deliveryContent).toMatch(
      /^\[SAM: This message is from grace, .* olivia owns this session\./
    );
  });

  it('refuses a grantee’s attachments before touching uploads or the session', async () => {
    const env = envWith();

    await expect(
      sendChat(env, 'grantee-1', 'project-1', 'session-1', {
        content: 'Read this',
        attachments: [attachment],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Attachments are not supported in a shared session yet',
    });
    expect(env.R2.head).not.toHaveBeenCalled();
    expect(mocks.cancelSleep).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('still accepts the owner’s attachments', async () => {
    const env = envWith();

    await sendChat(env, 'owner-1', 'project-1', 'session-1', {
      content: 'Read this',
      attachments: [attachment],
    });

    expect(env.R2.head).toHaveBeenCalledWith('temp-uploads/owner-1/upload-1/context.txt');
    expect(mocks.accept.mock.calls[0]![2].metadata).toEqual({
      userId: 'owner-1',
      attachments: [attachment],
    });
  });

  it('refuses a grantee prompt with 409 when durable delivery is off, without the live fallback', async () => {
    const env = envWith({ DURABLE_PROMPT_DELIVERY_ENABLED: 'false' });

    await expect(
      sendChat(env, 'grantee-1', 'project-1', 'session-1', { content: 'Please add a test' })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Shared session messages require durable prompt delivery',
    });
    expect(mocks.forward).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.cancelSleep).not.toHaveBeenCalled();
  });

  it('still sends the owner’s prompt live when durable delivery is off', async () => {
    const env = envWith({ DURABLE_PROMPT_DELIVERY_ENABLED: 'false' });

    await expect(
      sendChat(env, 'owner-1', 'project-1', 'session-1', { content: 'Ship it' })
    ).resolves.toEqual({ ok: true });

    expect(mocks.forward).toHaveBeenCalledWith(env, expect.anything(), {
      projectId: 'project-1',
      sessionId: 'session-1',
      userId: 'owner-1',
      content: 'Ship it',
      enrichedMessage: 'Ship it',
    });
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
