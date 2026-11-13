/**
 * The worker's binding of @simple-agent-manager/ai-proxy's ports: each port must reach the
 * worker service the moved code used to call directly, with the same arguments.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPlatformAgentCredential: vi.fn(),
  resolveAdminSetting: vi.fn(),
  drizzle: vi.fn(() => ({ handle: 'fresh' })),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: mocks.getPlatformAgentCredential,
}));
vi.mock('../../../src/services/admin-settings-resolution', () => ({
  resolveAdminSetting: mocks.resolveAdminSetting,
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));

import type { Env } from '../../../src/env';
import { aiProxyPorts } from '../../../src/services/ai-proxy-ports';

const env = {
  DATABASE: { name: 'd1' },
  ENCRYPTION_KEY: 'shared-key',
  CREDENTIAL_ENCRYPTION_KEY: 'credential-key',
} as unknown as Env;

describe('aiProxyPorts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the Claude Code platform credential with the credential encryption key', async () => {
    const db = { handle: 'caller' } as never;
    mocks.getPlatformAgentCredential.mockResolvedValueOnce({
      credential: 'sk-ant-platform',
      credentialKind: 'api-key',
      credentialId: 'cred-1',
    });

    const key = await aiProxyPorts(env, db).getPlatformAnthropicKey();

    expect(key).toEqual({ credentialId: 'cred-1', credential: 'sk-ant-platform' });
    expect(mocks.getPlatformAgentCredential).toHaveBeenCalledWith(
      db,
      'claude-code',
      'credential-key'
    );
    expect(mocks.drizzle).not.toHaveBeenCalled();
  });

  it('opens its own handle when the caller passes none, and returns null without a credential', async () => {
    mocks.getPlatformAgentCredential.mockResolvedValueOnce(null);

    await expect(aiProxyPorts(env).getPlatformAnthropicKey()).resolves.toBeNull();
    expect(mocks.drizzle).toHaveBeenCalledWith(env.DATABASE);
    expect(mocks.getPlatformAgentCredential).toHaveBeenCalledWith(
      { handle: 'fresh' },
      'claude-code',
      'credential-key'
    );
  });

  it('reads the external read timeout admin setting as a number', async () => {
    mocks.resolveAdminSetting.mockResolvedValueOnce('4500');

    await expect(aiProxyPorts(env).externalReadTimeoutMs()).resolves.toBe(4500);
    expect(mocks.resolveAdminSetting).toHaveBeenCalledWith(
      env,
      'performance.externalReadTimeoutMs'
    );
  });
});
