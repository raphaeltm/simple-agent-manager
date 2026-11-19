/**
 * Archiving a question still held as an attention marker (`archiveAttention`): who may release
 * the shared answer/archive claim when completing it fails. Replaced edges only: the ProjectData
 * claim RPCs, project capability, the chat-writer check, the live update and the audit record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  prepareAttentionArchive: vi.fn(),
  completeAttentionArchive: vi.fn(),
  releaseAttentionArchive: vi.fn(),
  announceQuestionArchived: vi.fn(),
  recordSharedSessionAnswer: vi.fn(),
}));
vi.mock('../../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/project-data')>(
    '../../../src/services/project-data'
  )),
  prepareAttentionArchive: edges.prepareAttentionArchive,
  completeAttentionArchive: edges.completeAttentionArchive,
  releaseAttentionArchive: edges.releaseAttentionArchive,
}));
vi.mock('../../../src/middleware/project-auth', async () => ({
  ...(await vi.importActual<typeof import('../../../src/middleware/project-auth')>(
    '../../../src/middleware/project-auth'
  )),
  requireProjectCapability: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/session-access', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/session-access')>(
    '../../../src/services/session-access'
  )),
  requireSessionWriter: vi.fn(async () => ({ ownerUserId: 'owner', actorUserId: 'owner' })),
  recordSharedSessionAnswer: edges.recordSharedSessionAnswer,
}));
vi.mock('../../../src/services/inbox/agent-asks', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/inbox/agent-asks')>(
    '../../../src/services/inbox/agent-asks'
  )),
  announceQuestionArchived: edges.announceQuestionArchived,
}));

import type { Env } from '../../../src/env';
import { archiveAttention } from '../../../src/routes/chat-attention';

const env = { DATABASE: {} } as unknown as Env;
const archive = () =>
  archiveAttention(env, 'owner', 'proj-1', 'chat-1', 'marker-1', {
    archivedAt: Date.now(),
    holdCheckinsUntil: Date.now() + 3_600_000,
  });

describe('archiveAttention: the staged claim when completing it fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edges.completeAttentionArchive.mockRejectedValue(new Error('DO unavailable'));
  });

  it('releases a claim this request staged, so the question stays answerable', async () => {
    edges.prepareAttentionArchive.mockResolvedValue({ status: 'ready' });
    await expect(archive()).rejects.toThrow('DO unavailable');
    expect(edges.releaseAttentionArchive).toHaveBeenCalledWith(env, 'proj-1', 'chat-1', 'marker-1');
    expect(edges.announceQuestionArchived).not.toHaveBeenCalled();
  });

  it('leaves alone a claim it found already staged: another request may still own it', async () => {
    edges.prepareAttentionArchive.mockResolvedValue({ status: 'in_flight', answer: '' });
    await expect(archive()).rejects.toThrow('DO unavailable');
    // Completing it was attempted (a stranded claim is finished)...
    expect(edges.completeAttentionArchive).toHaveBeenCalledTimes(1);
    // ...but a failure never releases a claim this request does not own.
    expect(edges.releaseAttentionArchive).not.toHaveBeenCalled();
  });

  it('a stranded claim from an earlier build is completed, telling the agent nothing', async () => {
    edges.prepareAttentionArchive.mockResolvedValue({ status: 'in_flight', answer: '' });
    edges.completeAttentionArchive.mockResolvedValue(1);
    await expect(archive()).resolves.toEqual({ agentNotified: false });
    expect(edges.completeAttentionArchive).toHaveBeenCalledTimes(1);
    expect(edges.releaseAttentionArchive).not.toHaveBeenCalled();
    expect(edges.announceQuestionArchived).toHaveBeenCalledTimes(1);
  });
});
