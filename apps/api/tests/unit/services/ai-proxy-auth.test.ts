import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { verifyAIProxyAuth } from '../../../src/services/ai-proxy-shared';
import { verifyCallbackToken } from '../../../src/services/jwt';
import { validateMcpToken } from '../../../src/services/mcp-token';

vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../../src/services/mcp-token', () => ({
  validateMcpToken: vi.fn(),
}));

const mockVerifyCallbackToken = vi.mocked(verifyCallbackToken);
const mockValidateMcpToken = vi.mocked(validateMcpToken);

describe('verifyAIProxyAuth MCP token experiment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts task MCP tokens when the harness experiment flag is enabled', async () => {
    mockVerifyCallbackToken.mockRejectedValueOnce(new Error('Invalid token'));
    mockValidateMcpToken.mockResolvedValueOnce({
      taskId: 'task-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      createdAt: '2026-05-03T00:00:00.000Z',
    });

    const result = await verifyAIProxyAuth(
      'mcp-token',
      {
        AI_PROXY_ACCEPT_MCP_TOKEN_FOR_HARNESS: 'true',
        KV: {} as KVNamespace,
      } as Env,
      {} as Parameters<typeof verifyAIProxyAuth>[2],
    );

    expect(result).toEqual({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });
    expect(mockValidateMcpToken).toHaveBeenCalledWith({}, 'mcp-token');
  });

  it('does not try MCP token auth unless the harness experiment flag is enabled', async () => {
    const authError = new Error('Invalid token');
    mockVerifyCallbackToken.mockRejectedValueOnce(authError);

    await expect(verifyAIProxyAuth(
      'mcp-token',
      {
        KV: {} as KVNamespace,
      } as Env,
      {} as Parameters<typeof verifyAIProxyAuth>[2],
    )).rejects.toThrow('Invalid token');

    expect(mockValidateMcpToken).not.toHaveBeenCalled();
  });

  it('preserves callback-token errors when no matching MCP token exists', async () => {
    const authError = new Error('Invalid token');
    mockVerifyCallbackToken.mockRejectedValueOnce(authError);
    mockValidateMcpToken.mockResolvedValueOnce(null);

    await expect(verifyAIProxyAuth(
      'expired-token',
      {
        AI_PROXY_ACCEPT_MCP_TOKEN_FOR_HARNESS: 'true',
        KV: {} as KVNamespace,
      } as Env,
      {} as Parameters<typeof verifyAIProxyAuth>[2],
    )).rejects.toThrow('Invalid token');
  });
});
