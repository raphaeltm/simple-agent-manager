/**
 * Tests for OpenCode agent key provider resolution.
 *
 * OpenCode is a bring-your-own-key agent. The default provider is Zen and every
 * OpenCode provider (Zen, Go, custom) requires a dedicated OpenCode API key —
 * there is no Scaleway reuse and no platform-proxy fallback. When no dedicated
 * key exists the agent-key endpoint returns 404.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { workspacesRoutes } from '../../../src/routes/workspaces';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'test-user-id',
  getAuth: () => ({ userId: 'test-user-id' }),
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: vi
    .fn()
    .mockResolvedValue({ workspace: 'ws-123', type: 'callback', scope: 'workspace' }),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('../../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: vi.fn().mockResolvedValue(false),
}));

const { decrypt } = await import('../../../src/services/encryption');
const mockDecrypt = vi.mocked(decrypt);

describe('POST /workspaces/:id/agent-key — OpenCode provider resolution', () => {
  let app: Hono<{ Bindings: Env }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDB: any;

  const mockEnv = {
    DATABASE: {} as D1Database,
    ENCRYPTION_KEY: 'test-key',
    JWT_PUBLIC_KEY: 'test-public-key',
    CALLBACK_TOKEN_AUDIENCE: 'test-audience',
    CALLBACK_TOKEN_ISSUER: 'test-issuer',
  } as unknown as Env;

  function postAgentKey(body: unknown): Promise<Response> {
    return app.request(
      '/api/workspaces/ws-123/agent-key',
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-callback-token',
        },
      },
      mockEnv
    );
  }

  // The workspace row carries no projectId, so the project-scoped credential
  // query is skipped. The user-scoped credential query consumes response #1
  // (after the workspace lookup) and the platform credential query consumes #2.
  function queueLimitResponses(...responses: unknown[][]): void {
    const queued = [...responses];
    mockDB.limit.mockImplementation(() => queued.shift() ?? []);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as {
        statusCode?: number;
        error?: string;
        message?: string;
      };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json(
          { error: appError.error, message: appError.message },
          appError.statusCode as 400 | 401 | 403 | 404 | 500
        );
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/workspaces', workspacesRoutes);

    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    };
    vi.mocked(drizzle).mockReturnValue(mockDB as ReturnType<typeof drizzle>);
  });

  it('returns 404 for default OpenCode Zen when no dedicated OpenCode key exists', async () => {
    queueLimitResponses([{ userId: 'user-1' }], [], []);

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.message).toBe('Agent credential not found');
  });

  it('returns the dedicated opencode key without any proxy fallback', async () => {
    queueLimitResponses(
      [{ userId: 'user-1' }],
      [
        {
          encryptedToken: 'encrypted-dedicated',
          iv: 'iv-dedicated',
          credentialKind: 'api-key',
          isActive: true,
        },
      ]
    );

    mockDecrypt.mockResolvedValueOnce('dedicated-opencode-key');

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.apiKey).toBe('dedicated-opencode-key');
    expect(json.credentialKind).toBe('api-key');
    expect(json.inferenceConfig).toBeUndefined();
  });

  it('returns 404 for default OpenCode Zen when AI proxy is enabled or disabled', async () => {
    // Override env to disable AI proxy
    const disabledEnv = { ...mockEnv, AI_PROXY_ENABLED: 'false' } as unknown as Env;
    const disabledApp = new Hono<{ Bindings: Env }>();
    disabledApp.route('/', workspacesRoutes);
    // Re-mount with disabled proxy env
    const resp = await disabledApp.request(
      '/api/workspaces/ws-123/agent-key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ agentType: 'opencode' }),
      },
      disabledEnv
    );
    expect(resp.status).toBe(404);
  });

  it('does not resolve a key for non-opencode agents without a credential', async () => {
    queueLimitResponses([{ userId: 'user-1' }]);

    const resp = await postAgentKey({ agentType: 'google-gemini' });
    expect(resp.status).toBe(404);
  });

  it.each([
    ['OpenCode Zen', 'encrypted-zen-key', 'iv-zen', 'opencode-zen-api-key'],
    ['OpenCode Go', 'encrypted-go-key', 'iv-go', 'opencode-go-api-key'],
  ])(
    'returns the dedicated key directly for %s instead of routing through any proxy',
    async (_label, encryptedToken, iv, decryptedKey) => {
      queueLimitResponses(
        [{ userId: 'user-1' }],
        [
          {
            encryptedToken,
            iv,
            credentialKind: 'api-key',
            isActive: true,
          },
        ]
      );
      mockDecrypt.mockResolvedValueOnce(decryptedKey);

      const resp = await postAgentKey({ agentType: 'opencode' });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.apiKey).toBe(decryptedKey);
      expect(body.credentialKind).toBe('api-key');
      expect(body.inferenceConfig).toBeUndefined();
    }
  );

  it('returns 404 and does not fall back to any platform/cloud credential when no key exists', async () => {
    queueLimitResponses([{ userId: 'user-1' }], [], []);

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.message).toBe('Agent credential not found');
    // Workspace lookup + user-scoped credential query + platform credential query.
    expect(mockDB.limit).toHaveBeenCalledTimes(3);
  });
});
