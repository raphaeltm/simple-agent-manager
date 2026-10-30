import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../src/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/client')>()),
  request: mocks.request,
}));

import { createAgentCredentialSetupSession } from '../../../src/lib/api/codex-setup';

describe('guided account connection API scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue({ id: 'setup', status: 'provisioning' });
  });

  it.each(['claude-code', 'openai-codex'] as const)(
    'includes the project destination for %s',
    async (agentType) => {
      await createAgentCredentialSetupSession(agentType, 'client-project');
      expect(mocks.request).toHaveBeenCalledWith('/api/agent-credential-setup-sessions', {
        method: 'POST',
        body: JSON.stringify({ agentType, projectId: 'client-project' }),
      });
    }
  );

  it('omits project scope for a personal default connection', async () => {
    await createAgentCredentialSetupSession('claude-code');
    expect(mocks.request).toHaveBeenCalledWith('/api/agent-credential-setup-sessions', {
      method: 'POST',
      body: JSON.stringify({ agentType: 'claude-code' }),
    });
  });
});
