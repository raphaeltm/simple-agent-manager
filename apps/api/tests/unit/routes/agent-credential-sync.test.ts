/**
 * Behavioral tests for the POST /workspaces/:id/agent-credential-sync endpoint.
 *
 * These tests mount the workspacesRoutes on a Hono app, mock dependencies,
 * and verify actual HTTP responses — not source code patterns.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { workspacesRoutes } from '../../../src/routes/workspaces';

// Mock external dependencies used by the endpoint.
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
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'new-encrypted', iv: 'new-iv' }),
  decrypt: vi.fn().mockResolvedValue('old-credential-value'),
}));

const { decrypt, encrypt } = await import('../../../src/services/encryption');

describe('POST /workspaces/:id/agent-credential-sync', () => {
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

  const validBody = {
    agentType: 'openai-codex',
    credentialKind: 'oauth-token',
    credential: '{"tokens":{"access_token":"new-jwt"}}',
  };

  /** Helper: issue a POST to the endpoint with proper env bindings. */
  function postSync(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
          ...headers,
        },
        body: JSON.stringify(body),
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
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };

    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);
  });

  /** Helper: set up sequential .limit() results for workspace + credential lookups. */
  function setupDBMocks(
    workspaceRow: Record<string, unknown> | null,
    credentialRow: Record<string, unknown> | null,
  ) {
    const chain = mockDB.limit;
    chain.mockResolvedValueOnce(workspaceRow ? [workspaceRow] : []);
    chain.mockResolvedValueOnce(credentialRow ? [credentialRow] : []);
  }

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
        },
        body: 'not-json',
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('valid JSON');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await postSync({ agentType: 'openai-codex' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('agentType, credentialKind, and credential are required');
  });

  it('returns 400 for invalid agentType', async () => {
    const res = await postSync({ ...validBody, agentType: 'bad-agent' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid agentType');
  });

  it('returns 400 for invalid credentialKind', async () => {
    const res = await postSync({ ...validBody, credentialKind: 'bad-kind' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid credentialKind');
  });

  it('returns 404 when workspace does not exist', async () => {
    setupDBMocks(null, null);

    const res = await postSync(validBody);
    expect(res.status).toBe(404);
  });

  it('returns credential_not_found when no matching credential exists', async () => {
    setupDBMocks({ userId: 'user-1', nodeId: 'node-1' }, null);

    const res = await postSync(validBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: false, reason: 'credential_not_found' });
  });

  it('returns updated:false when credential is unchanged', async () => {
    setupDBMocks(
      { userId: 'user-1', nodeId: 'node-1' },
      { id: 'cred-1', encryptedToken: 'enc', iv: 'iv', isActive: true },
    );
    // decrypt returns the same value as the submitted credential
    (decrypt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      validBody.credential,
    );

    const res = await postSync(validBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, updated: false });
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('re-encrypts and returns updated:true when credential has changed', async () => {
    setupDBMocks(
      { userId: 'user-1', nodeId: 'node-1' },
      { id: 'cred-1', encryptedToken: 'enc', iv: 'iv', isActive: true },
    );
    // decrypt returns a different value than the submitted credential
    (decrypt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      'old-different-value',
    );

    const res = await postSync(validBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, updated: true });

    // Verify encrypt was called with the new credential
    expect(encrypt).toHaveBeenCalledWith(validBody.credential, 'test-key');
    // Verify db.update was called
    expect(mockDB.update).toHaveBeenCalled();
    expect(mockDB.set).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedToken: 'new-encrypted',
        iv: 'new-iv',
      }),
    );
  });

  it('rejects oversized payloads', async () => {
    const res = await app.request(
      '/api/workspaces/ws-123/agent-credential-sync',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-callback-token',
          'Content-Length': '100000',
        },
        body: JSON.stringify(validBody),
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Payload exceeds');
  });
});
