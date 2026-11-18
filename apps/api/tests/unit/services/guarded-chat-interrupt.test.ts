import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { guardedChatInterrupt } from '../../../src/services/guarded-chat-interrupt';
import { nodeAgentRequest } from '../../../src/services/node-agent';
vi.mock('../../../src/services/node-agent', () => ({ nodeAgentRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('guarded interrupt transport', () => {
  it('sends guard only to distinct no-wake endpoint with current writer hook', async () => {
    vi.mocked(nodeAgentRequest).mockResolvedValue({ status: 'cancelled' });
    const guard = vi.fn(async () => undefined);
    await expect(
      guardedChatInterrupt({} as Env, 'node', 'workspace', 'agent', 'owner', 17, guard)
    ).resolves.toEqual({ success: true, status: 200 });
    expect(nodeAgentRequest).toHaveBeenCalledWith(
      'node',
      {},
      '/workspaces/workspace/agent-sessions/agent/cancel-guarded',
      expect.objectContaining({
        beforeExternalMutation: guard,
        noWakeContainer: true,
        recoverContainerOnTimeout: false,
        body: '{"expectedPromptStartedAt":17}',
      })
    );
  });
  it.each([404, 412, 500])(
    'never falls back after %s and strips remote error body',
    async (status) => {
      vi.mocked(nodeAgentRequest).mockRejectedValue(
        new Error(`Node Agent request failed: ${status} secret-canary`)
      );
      const error = await guardedChatInterrupt(
        {} as Env,
        'node',
        'workspace',
        'agent',
        'owner',
        17
      ).catch((error) => error);
      expect(error.message).not.toContain('secret-canary');
      expect(nodeAgentRequest).toHaveBeenCalledTimes(1);
    }
  );
});
