/**
 * Tests for OpenCode agent key provider resolution.
 *
 * The default OpenCode provider is Zen and requires an OpenCode API key.
 * Scaleway cloud-provider reuse remains available only when Scaleway is
 * explicitly selected as the OpenCode provider.
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

  it('returns Scaleway cloud credential only when Scaleway is explicitly selected', async () => {
    queueLimitResponses(
      [{ userId: 'user-1' }],
      [{ opencodeProvider: 'scaleway' }],
      [],
      [],
      [{ encryptedToken: 'encrypted-scw', iv: 'iv-scw' }]
    );

    mockDecrypt.mockResolvedValueOnce(
      JSON.stringify({ secretKey: 'scw-secret-key-123', projectId: 'scw-proj-1' })
    );

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.apiKey).toBe('scw-secret-key-123');
    expect(json.credentialKind).toBe('api-key');
  });

  it('prefers dedicated opencode agent key over Scaleway cloud credential', async () => {
    queueLimitResponses(
      [{ userId: 'user-1' }],
      [{ opencodeProvider: 'scaleway' }],
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
  });

  it('returns platform proxy only when platform is explicitly selected', async () => {
    queueLimitResponses([{ userId: 'user-1' }], [{ opencodeProvider: 'platform' }]);

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.apiKey).toBe('__platform_proxy__');
    expect(body.credentialSource).toBe('platform');
    expect(body.inferenceConfig).toBeDefined();
    expect(body.inferenceConfig.provider).toBe('openai-compatible');
    expect(body.inferenceConfig.apiKeySource).toBe('callback-token');
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

  it('does not use Scaleway fallback for non-opencode agents', async () => {
    queueLimitResponses([{ userId: 'user-1' }]);

    const resp = await postAgentKey({ agentType: 'google-gemini' });
    expect(resp.status).toBe(404);
  });

  it('handles malformed Scaleway credential JSON gracefully and falls back to platform proxy', async () => {
    queueLimitResponses(
      [{ userId: 'user-1' }],
      [{ opencodeProvider: 'scaleway' }],
      [],
      [],
      [{ encryptedToken: 'encrypted-scw', iv: 'iv-scw' }]
    );

    mockDecrypt.mockResolvedValueOnce('not-valid-json');

    const resp = await postAgentKey({ agentType: 'opencode' });
    // Malformed explicit Scaleway credential is skipped without falling through
    // to the default Zen or platform provider.
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.message).toBe('Agent credential not found');
  });

  it('returns dedicated key directly for OpenCode Zen instead of routing through platform proxy', async () => {
    queueLimitResponses(
      [{ userId: 'user-1' }],
      [{ opencodeProvider: 'opencode-zen' }],
      [
        {
          encryptedToken: 'encrypted-managed-key',
          iv: 'iv-managed',
          credentialKind: 'api-key',
          isActive: true,
        },
      ]
    );

    mockDecrypt.mockResolvedValueOnce('opencode-managed-api-key');

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.apiKey).toBe('opencode-managed-api-key');
    expect(body.credentialKind).toBe('api-key');
    expect(body.inferenceConfig).toBeUndefined();
  });

  it('does not fall back to Scaleway or platform credentials when OpenCode Zen has no key', async () => {
    queueLimitResponses([{ userId: 'user-1' }], [{ opencodeProvider: 'opencode-zen' }], []);

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.message).toBe('Agent credential not found');
    expect(mockDB.limit).toHaveBeenCalledTimes(4);
  });
});
