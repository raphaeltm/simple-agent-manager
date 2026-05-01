/**
 * Tests for Codex (openai-codex) agent key fallback to AI proxy.
 *
 * When agentType === 'openai-codex' and no dedicated agent credential exists,
 * the agent-key endpoint falls back to the platform AI proxy with
 * inferenceConfig { provider: 'openai-proxy' }.
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

describe('POST /workspaces/:id/agent-key — Codex AI proxy fallback', () => {
  let app: Hono<{ Bindings: Env }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDB: any;

  const mockEnv = {
    DATABASE: {} as D1Database,
    ENCRYPTION_KEY: 'test-key',
    JWT_PUBLIC_KEY: 'test-public-key',
    CALLBACK_TOKEN_AUDIENCE: 'test-audience',
    CALLBACK_TOKEN_ISSUER: 'test-issuer',
    BASE_DOMAIN: 'sammy.party',
    KV: { get: vi.fn().mockResolvedValue(null) },
  } as unknown as Env;

  function postAgentKey(body: unknown, env?: Env): Promise<Response> {
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
      env ?? mockEnv,
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
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    vi.mocked(drizzle).mockReturnValue(mockDB as ReturnType<typeof drizzle>);
  });

  it('returns openai-proxy inferenceConfig when no openai-codex credential exists', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        // workspace lookup
        return [{ userId: 'user-1', projectId: null }];
      }
      // All credential lookups return empty
      return [];
    });

    const resp = await postAgentKey({ agentType: 'openai-codex' });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.apiKey).toBe('__platform_proxy__');
    expect(body.credentialSource).toBe('platform');
    expect(body.credentialKind).toBe('api-key');
    expect(body.inferenceConfig).toBeDefined();
    expect(body.inferenceConfig.provider).toBe('openai-proxy');
    expect(body.inferenceConfig.baseURL).toBe('https://api.sammy.party/ai/v1');
    expect(body.inferenceConfig.apiKeySource).toBe('callback-token');
    expect(body.inferenceConfig.model).toBe('gpt-4.1');
  });

  it('returns user credential when openai-codex credential exists (no proxy fallback)', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        // workspace lookup
        return [{ userId: 'user-1', projectId: null }];
      }
      if (queryCount === 2) {
        // agent-api-key for 'openai-codex' (user-scoped) → found
        return [{
          encryptedToken: 'encrypted-key',
          iv: 'iv-key',
          credentialKind: 'api-key',
          isActive: true,
        }];
      }
      return [];
    });

    mockDecrypt.mockResolvedValueOnce('sk-openai-user-key-123');

    const resp = await postAgentKey({ agentType: 'openai-codex' });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.apiKey).toBe('sk-openai-user-key-123');
    expect(body.credentialKind).toBe('api-key');
    // Should NOT have inferenceConfig — user credential takes precedence
    expect(body.inferenceConfig).toBeUndefined();
  });

  it('returns 404 when no credential and AI proxy is disabled', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1', projectId: null }];
      }
      return [];
    });

    const disabledEnv = { ...mockEnv, AI_PROXY_ENABLED: 'false' } as unknown as Env;
    const resp = await postAgentKey({ agentType: 'openai-codex' }, disabledEnv);
    expect(resp.status).toBe(404);
  });

  it('uses custom model from AI_PROXY_DEFAULT_OPENAI_MODEL env var when set', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1', projectId: null }];
      }
      return [];
    });

    const customEnv = {
      ...mockEnv,
      AI_PROXY_DEFAULT_OPENAI_MODEL: 'gpt-4.1-mini',
    } as unknown as Env;

    const resp = await postAgentKey({ agentType: 'openai-codex' }, customEnv);
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.inferenceConfig.model).toBe('gpt-4.1-mini');
  });

  it('tracks credential source on associated task', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        // workspace lookup
        return [{ userId: 'user-1', projectId: null }];
      }
      if (queryCount <= 3) {
        // Credential lookups (user-scoped + platform) → empty
        return [];
      }
      // Task lookup (inside AI proxy fallback block)
      if (queryCount === 4) return [{ id: 'task-1' }];
      return [];
    });

    const resp = await postAgentKey({ agentType: 'openai-codex' });
    expect(resp.status).toBe(200);

    // Verify update was called (task credential source tracking)
    expect(mockDB.update).toHaveBeenCalled();
  });

  it('does NOT affect existing opencode proxy fallback', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1', projectId: null }];
      }
      return [];
    });

    const resp = await postAgentKey({ agentType: 'opencode' });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    // OpenCode should still get openai-compatible, not openai-proxy
    expect(body.inferenceConfig.provider).toBe('openai-compatible');
  });

  it('does NOT affect existing claude-code proxy fallback', async () => {
    let queryCount = 0;
    mockDB.limit.mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) {
        return [{ userId: 'user-1', projectId: null }];
      }
      return [];
    });

    const resp = await postAgentKey({ agentType: 'claude-code' });
    expect(resp.status).toBe(200);

    const body = await resp.json();
    // Claude Code should still get anthropic-proxy
    expect(body.inferenceConfig.provider).toBe('anthropic-proxy');
  });
});
