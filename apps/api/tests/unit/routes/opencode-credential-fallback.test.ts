/**
 * Tests for OpenCode agent key fallback to Scaleway cloud provider credential.
 *
 * When agentType === 'opencode' and no dedicated agent-api-key exists,
 * the agent-key endpoint falls back to the Scaleway cloud-provider credential,
 * extracting the secretKey from the JSON-serialized token.
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
  verifyCallbackToken: vi.fn().mockResolvedValue({ workspace: 'ws-123', type: 'callback', scope: 'workspace' }),
  signCallbackToken: vi.fn(),
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));

const { decrypt } = await import('../../../src/services/encryption');
const mockDecrypt = vi.mocked(decrypt);

describe('POST /workspaces/:id/agent-key — OpenCode Scaleway fallback', () => {
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
      mockEnv,
    );
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
      if (
        typeof appError.statusCode === 'number' &&
        typeof appError.error === 'string'
      ) {
        return c.json(
          { error: appError.error, message: appError.message },
          appError.statusCode as 400 | 401 | 403 | 404 | 500,
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

  it('returns Scaleway cloud credential when no dedicated opencode agent key exists', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1' }];
      }
      if (queryCount === 2) {
        // agent-api-key for 'opencode' → not found
        return [];
      }
      if (queryCount === 3) {
        // platform credential → not found
        return [];
      }
      if (queryCount === 4) {
        // cloud-provider for 'scaleway' → found
        return [{ encryptedToken: 'encrypted-scw', iv: 'iv-scw' }];
      }
      return [];
    });

    mockDecrypt.mockResolvedValueOnce(JSON.stringify({ secretKey: 'scw-secret-key-123', projectId: 'scw-proj-1' }));

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.apiKey).toBe('scw-secret-key-123');
    expect(json.credentialKind).toBe('api-key');
  });

  it('prefers dedicated opencode agent key over Scaleway cloud credential', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1' }];
      }
      if (queryCount === 2) {
        // agent-api-key for 'opencode' → found
        return [{
          encryptedToken: 'encrypted-dedicated',
          iv: 'iv-dedicated',
          credentialKind: 'api-key',
          isActive: true,
        }];
      }
      return [];
    });

    mockDecrypt.mockResolvedValueOnce('dedicated-opencode-key');

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);

    const json = await resp.json();
    expect(json.apiKey).toBe('dedicated-opencode-key');
    expect(json.credentialKind).toBe('api-key');
  });

  it('returns platform proxy fallback when no opencode key AND no Scaleway cloud credential', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1' }];
      }
      return [];
    });

    const resp = await postAgentKey({ agentType: 'opencode' });
    // With AI proxy enabled (default), opencode falls back to platform proxy
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.apiKey).toBe('__platform_proxy__');
    expect(body.credentialSource).toBe('platform');
    expect(body.inferenceConfig).toBeDefined();
    expect(body.inferenceConfig.provider).toBe('openai-compatible');
    expect(body.inferenceConfig.apiKeySource).toBe('callback-token');
  });

  it('returns 404 when no opencode key AND no Scaleway credential AND AI proxy disabled', async () => {
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
      disabledEnv,
    );
    expect(resp.status).toBe(404);
  });

  it('does not use Scaleway fallback for non-opencode agents', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1' }];
      }
      return [];
    });

    const resp = await postAgentKey({ agentType: 'claude-code' });
    expect(resp.status).toBe(404);
  });

  it('handles malformed Scaleway credential JSON gracefully and falls back to platform proxy', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1' }];
      }
      if (queryCount === 2) {
        return []; // no dedicated user agent key
      }
      if (queryCount === 3) {
        return []; // no platform credential
      }
      if (queryCount === 4) {
        return [{ encryptedToken: 'encrypted-scw', iv: 'iv-scw' }]; // scaleway cloud provider
      }
      return [];
    });

    mockDecrypt.mockResolvedValueOnce('not-valid-json');

    const resp = await postAgentKey({ agentType: 'opencode' });
    // Malformed Scaleway credential is skipped, falls through to platform proxy
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.apiKey).toBe('__platform_proxy__');
    expect(body.credentialSource).toBe('platform');
  });
});
