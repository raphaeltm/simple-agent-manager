import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { SendChatMessageSchema } from '../../../src/schemas';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  authorize: vi.fn(),
  writer: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.authorize,
}));
vi.mock('../../../src/services/session-access', () => ({
  requireSessionWriter: mocks.writer,
}));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: vi.fn(async (message) => ({ enrichedMessage: message })),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  cancelScheduledSessionSleep: mocks.cancel,
}));
vi.mock('../../../src/services/project-data', () => ({ acceptPromptDelivery: mocks.accept }));
import * as v from 'valibot';

import { sendChat } from '../../../src/services/send-chat';

const env = { DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as unknown as Env;

describe('composer delivery intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accept.mockResolvedValue({ message: { id: 'delivery' }, transcriptMessageId: 'message' });
    mocks.writer.mockImplementation(
      async (_env: unknown, projectId: string, sessionId: string, userId: string) => ({
        projectId,
        sessionId,
        session: { id: sessionId },
        role: 'owner',
        actorUserId: userId,
        ownerUserId: userId,
        grantId: null,
      })
    );
  });

  it('accepts only the two intents at the route boundary', () => {
    expect(
      v.safeParse(SendChatMessageSchema, { content: 'x', deliveryIntent: 'steer' }).success
    ).toBe(true);
    expect(
      v.safeParse(SendChatMessageSchema, { content: 'x', deliveryIntent: 'interrupt' }).success
    ).toBe(false);
  });

  it('carries Steer now into the durable inbox as a non-urgent steer', async () => {
    expect(
      await sendChat(env, 'owner', 'project', 'chat', {
        content: 'use tabs',
        deliveryIntent: 'steer',
      })
    ).toMatchObject({ accepted: true, deliveryIntent: 'steer' });
    expect(mocks.accept).toHaveBeenCalledWith(
      env,
      'project',
      expect.objectContaining({
        deliveryIntent: 'steer',
        messageClass: 'deliver',
        senderType: 'human',
      })
    );
  });

  it('defaults to Queue next', async () => {
    await sendChat(env, 'owner', 'project', 'chat', { content: 'later' });
    expect(mocks.accept).toHaveBeenCalledWith(
      env,
      'project',
      expect.objectContaining({ deliveryIntent: 'queue' })
    );
  });

  it('refuses a steer carrying attachments before any side effect', async () => {
    await expect(
      sendChat(env, 'owner', 'project', 'chat', {
        content: 'see file',
        deliveryIntent: 'steer',
        attachments: [{ uploadId: 'u', filename: 'f.txt', size: 1, contentType: 'text/plain' }],
      })
    ).rejects.toThrow('Attachments cannot be sent as a steer');
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('refuses a steer longer than the mailbox bound, and still queues the same text', async () => {
    const limited = { ...env, MAILBOX_MESSAGE_MAX_LENGTH: '16' } as unknown as Env;
    const long = 'x'.repeat(17);
    await expect(
      sendChat(limited, 'owner', 'project', 'chat', { content: long, deliveryIntent: 'steer' })
    ).rejects.toThrow('too long to steer');
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
    // The bound is a steer bound: the same message as Queue next is accepted.
    await sendChat(limited, 'owner', 'project', 'chat', { content: long });
    expect(mocks.accept).toHaveBeenCalledTimes(1);
  });
});
