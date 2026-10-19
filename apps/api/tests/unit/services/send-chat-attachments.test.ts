import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  authorize: vi.fn(),
  creator: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: mocks.authorize,
}));
vi.mock('../../../src/services/session-access', () => ({
  requireSessionWriter: mocks.creator,
}));
vi.mock('../../../src/services/mention-enrichment', () => ({
  enrichMessageWithMentions: vi.fn(async (message) => ({ enrichedMessage: message })),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  cancelScheduledSessionSleep: mocks.cancel,
}));
vi.mock('../../../src/services/project-data', () => ({ acceptPromptDelivery: mocks.accept }));
import { sendChat } from '../../../src/services/send-chat';

const attachment = {
  uploadId: 'upload-1',
  filename: 'context.txt',
  size: 5,
  contentType: 'text/plain',
};
describe('follow-up attachment acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accept.mockResolvedValue({ message: { id: 'delivery' }, transcriptMessageId: 'message' });
    mocks.creator.mockImplementation(
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
  it('validates owned R2 objects, durably stores refs and exact paths without contacting the workspace', async () => {
    const head = vi.fn().mockResolvedValue({ size: 5 });
    const env = { R2: { head }, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as unknown as Env;
    expect(
      await sendChat(env, 'owner', 'project', 'sleeping-chat', {
        content: 'Read this',
        attachments: [attachment],
      })
    ).toMatchObject({ accepted: true });
    expect(head).toHaveBeenCalledWith('temp-uploads/owner/upload-1/context.txt');
    expect(mocks.accept).toHaveBeenCalledWith(
      env,
      'project',
      expect.objectContaining({
        targetSessionId: 'sleeping-chat',
        senderId: 'owner',
        metadata: { userId: 'owner', attachments: [attachment] },
        deliveryContent: expect.stringContaining('/workspaces/.private/upload-1/context.txt'),
      })
    );
  });
  it.each([
    { ...attachment, uploadId: '../other-user' },
    { ...attachment, filename: '../secret' },
    { ...attachment, size: -1 },
  ])('rejects malformed refs before R2 access: %j', async (invalid) => {
    const head = vi.fn();
    await expect(
      sendChat({ R2: { head } } as unknown as Env, 'owner', 'project', 'chat', {
        content: 'Read',
        attachments: [invalid],
      })
    ).rejects.toThrow('Invalid attachment');
    expect(head).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('rejects references absent from the authenticated user namespace', async () => {
    const head = vi.fn().mockResolvedValue(null);
    await expect(
      sendChat({ R2: { head } } as unknown as Env, 'owner', 'project', 'chat', {
        content: 'Read',
        attachments: [attachment],
      })
    ).rejects.toThrow('not found');
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
