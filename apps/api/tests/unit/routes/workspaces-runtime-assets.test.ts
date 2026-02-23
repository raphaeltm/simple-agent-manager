import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { workspacesRoutes } from '../../../src/routes/workspaces';

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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockResolvedValue('decrypted-secret');
    mocks.verifyCallbackToken.mockResolvedValue({ workspace: 'WS_1' });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/workspaces', workspacesRoutes);
  });

  it('returns decrypted runtime assets for linked project', async () => {
    let selectCall = 0;
    (drizzle as any).mockReturnValue({
      select: vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: 'WS_1', userId: 'user-1', projectId: 'proj-1' },
                ]),
              }),
            }),
          };
        }
        if (selectCall === 2) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  key: 'API_TOKEN',
                  storedValue: 'encrypted-value',
                  valueIv: 'iv',
                  isSecret: true,
                },
              ]),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                path: '.env.local',
                storedContent: 'FOO=bar',
                contentIv: null,
                isSecret: false,
              },
            ]),
          }),
        };
      }),
    });

    const res = await app.request('/api/workspaces/WS_1/runtime-assets', {
      method: 'GET',
      headers: { Authorization: 'Bearer callback-token' },
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'enc-key',
    } as Env);

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
});
