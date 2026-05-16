import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';
import { createRouteTestApp } from './route-test-app';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
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
vi.mock('../../../src/services/encryption', () => ({
  decrypt: mocks.decrypt,
}));

describe('workspaces runtime-assets callback route', () => {
  let app: Hono<{ Bindings: Env }>;
  const runtimeBindings = {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'enc-key',
  } as Env;

  const requestRuntimeAssets = () =>
    app.request('/api/workspaces/WS_1/runtime-assets', {
      method: 'GET',
      headers: { Authorization: 'Bearer callback-token' },
    }, runtimeBindings);

  const queryWhereRows = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });

  const queryLimitRows = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockResolvedValue('decrypted-secret');
    mocks.verifyCallbackToken.mockResolvedValue({ workspace: 'WS_1', type: 'callback', scope: 'workspace' });

    app = createRouteTestApp('/api/workspaces', workspacesRoutes);
  });

  it('returns decrypted runtime assets for linked project', async () => {
    let selectCall = 0;
    (drizzle as any).mockReturnValue({
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return queryLimitRows([{ id: 'WS_1', userId: 'user-1', projectId: 'proj-1' }]);
        }
        if (selectCall === 2) {
          return queryWhereRows([{
            key: 'API_TOKEN',
            storedValue: 'encrypted-value',
            valueIv: 'iv',
            isSecret: true,
          }]);
        }
        if (selectCall === 4) {
          return queryLimitRows([]);
        }
        return queryWhereRows([{
          path: '.env.local',
          storedContent: 'FOO=bar',
          contentIv: null,
          isSecret: false,
        }]);
      }),
    });

    const res = await requestRuntimeAssets();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe('WS_1');
    expect(body.envVars).toEqual([
      { key: 'API_TOKEN', value: 'decrypted-secret', isSecret: true },
    ]);
    expect(body.files).toEqual([
      { path: '.env.local', content: 'FOO=bar', isSecret: false },
    ]);
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-value', 'iv', 'enc-key');
  });

  it('merges profile runtime assets over project runtime assets', async () => {
    let selectCall = 0;
    (drizzle as any).mockReturnValue({
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return queryLimitRows([{ id: 'WS_1', userId: 'user-1', projectId: 'proj-1' }]);
        }
        if (selectCall === 2) {
          return queryWhereRows([
            { key: 'API_TOKEN', storedValue: 'project-token', valueIv: null, isSecret: false },
            { key: 'SHARED_KEY', storedValue: 'project-value', valueIv: null, isSecret: false },
          ]);
        }
        if (selectCall === 3) {
          return queryWhereRows([
            { path: '.env', storedContent: 'PROJECT=1', contentIv: null, isSecret: false },
            { path: 'shared.txt', storedContent: 'project-file', contentIv: null, isSecret: false },
          ]);
        }
        if (selectCall === 4) {
          return queryLimitRows([{ profileId: 'prof-1' }]);
        }
        if (selectCall === 5) {
          return queryLimitRows([{ id: 'prof-1' }]);
        }
        if (selectCall === 6) {
          return queryWhereRows([
            { key: 'SHARED_KEY', storedValue: 'profile-value', valueIv: null, isSecret: false },
            { key: 'PROFILE_ONLY', storedValue: 'profile-only', valueIv: null, isSecret: false },
          ]);
        }
        return queryWhereRows([
          { path: 'shared.txt', storedContent: 'profile-file', contentIv: null, isSecret: false },
          { path: 'profile.txt', storedContent: 'profile-only-file', contentIv: null, isSecret: false },
        ]);
      }),
    });

    const res = await requestRuntimeAssets();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envVars).toEqual([
      { key: 'API_TOKEN', value: 'project-token', isSecret: false },
      { key: 'SHARED_KEY', value: 'profile-value', isSecret: false },
      { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
    ]);
    expect(body.files).toEqual([
      { path: '.env', content: 'PROJECT=1', isSecret: false },
      { path: 'shared.txt', content: 'profile-file', isSecret: false },
      { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
    ]);
  });
});
