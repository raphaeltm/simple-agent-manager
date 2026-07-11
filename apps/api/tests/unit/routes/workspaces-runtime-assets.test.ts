import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { createRouteTestApp } from './route-test-app';

const mocks = vi.hoisted(() => ({
  getWorkspaceRuntimeAssets: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({ user: { id: 'user-1', name: 'User', email: 'user@example.com' } }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.verifyCallbackToken,
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/workspace-runtime-assets', () => ({
  getWorkspaceRuntimeAssets: mocks.getWorkspaceRuntimeAssets,
}));

describe('workspaces runtime-assets callback route', () => {
  let app: Hono<{ Bindings: Env }>;
  const runtimeBindings = {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'enc-key',
  } as Env;

  const requestRuntimeAssets = (path = '/api/workspaces/WS_1/runtime-assets') =>
    app.request(path, {
      method: 'GET',
      headers: { Authorization: 'Bearer callback-token' },
    }, runtimeBindings);

  beforeEach(() => {
    vi.clearAllMocks();
    (drizzle as any).mockReturnValue({ db: true });
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'WS_1',
      type: 'callback',
      scope: 'workspace',
    });
    mocks.getWorkspaceRuntimeAssets.mockResolvedValue({
      workspaceId: 'WS_1',
      envVars: [{ key: 'API_TOKEN', value: 'decrypted-secret', isSecret: true }],
      files: [{ path: '.env.local', content: 'FOO=bar', isSecret: false }],
    });

    app = createRouteTestApp('/api/workspaces', workspacesRoutes);
  });

  it('requires a workspace-scoped callback token and returns resolved assets', async () => {
    const res = await requestRuntimeAssets();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      workspaceId: 'WS_1',
      envVars: [{ key: 'API_TOKEN', value: 'decrypted-secret', isSecret: true }],
      files: [{ path: '.env.local', content: 'FOO=bar', isSecret: false }],
    });
    expect(mocks.getWorkspaceRuntimeAssets).toHaveBeenCalledWith(
      { db: true },
      { workspaceId: 'WS_1', agentSessionId: null },
      'enc-key'
    );
  });

  it('passes taskless agent session context to the resolver', async () => {
    const res = await requestRuntimeAssets('/api/workspaces/WS_1/runtime-assets?agentSessionId=agent-session-1');

    expect(res.status).toBe(200);
    expect(mocks.getWorkspaceRuntimeAssets).toHaveBeenCalledWith(
      { db: true },
      { workspaceId: 'WS_1', agentSessionId: 'agent-session-1' },
      'enc-key'
    );
  });

  it('rejects node-scoped callback tokens', async () => {
    mocks.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'WS_1',
      type: 'callback',
      scope: 'node',
    });

    const res = await requestRuntimeAssets();

    expect(res.status).toBe(403);
    expect(mocks.getWorkspaceRuntimeAssets).not.toHaveBeenCalled();
  });
});
