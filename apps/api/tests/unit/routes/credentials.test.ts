import type { SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createCredentialsTestApp, makeCredentialDbMock } from './credential-route-test-helpers';

// Mock dependencies
vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'test-ulid',
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'encrypted', iv: 'iv' }),
  decrypt: vi.fn().mockResolvedValue('decrypted-credential'),
}));

function makeTestEnv(): Env {
  // Rate-limit middleware on PUT /agent calls KV.get / KV.put; provide a no-op stub
  // that returns "first call in window" so every request is allowed.
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  // PUT autoActivate path uses `c.env.DATABASE.prepare().bind().run()` + `.batch()`
  // for atomic deactivate+upsert (cloudflare-specialist review). The drizzle mock
  // is insufficient here because raw D1 prepared statements go through DATABASE
  // directly, not through drizzle. Provide a minimal stub that satisfies the
  // fluent `.prepare(sql).bind(...).run()` chain and `.batch([...])`.
  const preparedStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const database = {
    prepare: vi.fn().mockReturnValue(preparedStmt),
    batch: vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]),
  };
  return {
    DATABASE: database as unknown as Env['DATABASE'],
    ENCRYPTION_KEY: 'test-key',
    KV: kv as unknown as Env['KV'],
  } as Env;
}

function putAgentCredential(app: Hono<{ Bindings: Env }>, request: unknown) {
  return app.request('/api/credentials/agent', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }, makeTestEnv());
}

function makeFakeSecret(prefix: string): string {
  return `${prefix}-${'1234567890abcdef'}`;
}

describe('Credentials Routes - OAuth Support', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = createCredentialsTestApp();

    // Mock database
    mockDB = makeCredentialDbMock();

    (drizzle as any).mockReturnValue(mockDB);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    );
  });

  describe('POST /api/credentials/agent/validate', () => {
    it('validates a Claude API key against the provider models endpoint without storing it', async () => {
      const claudeApiKey = makeFakeSecret('sk-ant-api03');
      const res = await app.request(
        '/api/credentials/agent/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentType: 'claude-code',
            credentialKind: 'api-key',
            credential: claudeApiKey,
          }),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
      expect(body.validationMode).toBe('provider');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-api-key': claudeApiKey }),
        })
      );
    });

    it('returns 400 when provider validation rejects the API key', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })
      );
      const claudeApiKey = makeFakeSecret('sk-ant-api03');

      const res = await app.request(
        '/api/credentials/agent/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentType: 'claude-code',
            credentialKind: 'api-key',
            credential: claudeApiKey,
          }),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid or unauthorized Claude Code credential');
    });

    it('validates OAuth credentials by format only', async () => {
      const oauthToken = `${makeFakeSecret('sk-ant-oat01')}abcdefghijklmnop`;
      const res = await app.request(
        '/api/credentials/agent/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentType: 'claude-code',
            credentialKind: 'oauth-token',
            credential: oauthToken,
          }),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.validationMode).toBe('format');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('validates Google API keys without placing the credential in the URL', async () => {
      const res = await app.request(
        '/api/credentials/agent/validate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentType: 'google-gemini',
            credentialKind: 'api-key',
            credential: 'google-api-key-1234567890',
          }),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models',
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-goog-api-key': 'google-api-key-1234567890' }),
        })
      );
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).not.toContain(
        'google-api-key-1234567890'
      );
    });
  });

  describe('PUT /api/credentials/agent - OAuth credential save flow', () => {
    it('should accept a Claude OAuth token with sk-ant-oat prefix', async () => {
      mockDB.limit.mockResolvedValueOnce([]); // No existing credential

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'sk-ant-oat01-1234567890abcdefghijklmnopqrstuvwxyz',
        autoActivate: true,
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.credentialKind).toBe('oauth-token');
      expect(body.isActive).toBe(true);
    });

    it('should save an OAuth token with correct credentialKind', async () => {
      mockDB.limit.mockResolvedValueOnce([]); // No existing credential

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'oauth_token_from_claude_setup_1234567890abcdefghijklmnopqrstuvwxyz',
        autoActivate: true,
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.credentialKind).toBe('oauth-token');
      expect(body.isActive).toBe(true);
      expect(body.label).toBe('Pro/Max Subscription');
      expect(body.maskedKey).toBe('...wxyz');
    });

    it('should auto-activate new OAuth token and deactivate existing API key', async () => {
      // Mock existing API key credential
      mockDB.limit.mockResolvedValueOnce([]);

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'new_oauth_token_1234567890abcdefghijklmnopqrstuvwxyz_1234567890',
        autoActivate: true,
      };

      const env = makeTestEnv();
      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        env
      );

      expect(res.status).toBe(201);

      // Autoactivate path now uses atomic DATABASE.batch([deactivate, upsert]).
      // Verify a deactivate statement was prepared with project_id IS NULL scope guard
      // (user-scoped deactivate must not affect project-scoped rows).
      const database = env.DATABASE as unknown as {
        prepare: ReturnType<typeof vi.fn>;
        batch: ReturnType<typeof vi.fn>;
      };
      expect(database.batch).toHaveBeenCalled();
      const prepareCalls = database.prepare.mock.calls.map((c) => c[0] as string);
      const deactivateSql = prepareCalls.find((sql) =>
        sql.includes('UPDATE credentials SET is_active = 0')
      );
      expect(deactivateSql).toBeDefined();
      expect(deactivateSql).toContain('project_id IS NULL');
    });

    it('should save API key when credentialKind is not specified (defaults to api-key)', async () => {
      const request = {
        agentType: 'claude-code',
        credential: 'sk-ant-api03-1234567890abcdef',
        // credentialKind not specified — defaults to 'api-key' in handler
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(201);
    });

    it('should accept an Amp API key from the shared agent catalog', async () => {
      mockDB.limit.mockResolvedValueOnce([]);

      const res = await putAgentCredential(app, {
        agentType: 'amp',
        credentialKind: 'api-key',
        credential: 'sgamp_test_access_token_1234567890',
        autoActivate: true,
      } satisfies SaveAgentCredentialRequest);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.agentType).toBe('amp');
      expect(body.provider).toBe('amp');
      expect(body.credentialKind).toBe('api-key');
      expect(body.label).toBeUndefined();
    });

    it('should reject Claude OAuth token when saved as API key', async () => {
      const request = {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-oat01-1234567890abcdefghijklmnopqrstuvwxyz',
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('OAuth token');
    });

    it('should reject OAuth token for unsupported agents', async () => {
      const request: SaveAgentCredentialRequest = {
        agentType: 'google-gemini',
        credentialKind: 'oauth-token',
        credential: 'oauth_token_that_is_long_enough_to_pass_validation_1234567890',
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('not supported');
    });

    it('should accept a Gemini API key credential', async () => {
      mockDB.limit.mockResolvedValueOnce([]);

      const request: SaveAgentCredentialRequest = {
        agentType: 'google-gemini',
        credentialKind: 'api-key',
        credential: 'gemini-api-key-1234567890',
        autoActivate: true,
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, makeTestEnv());

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.agentType).toBe('google-gemini');
      expect(body.provider).toBe('google');
      expect(body.credentialKind).toBe('api-key');
      expect(body.isActive).toBe(true);
    });

    it('should reject OAuth token for Amp', async () => {
      const res = await putAgentCredential(app, {
        agentType: 'amp',
        credentialKind: 'oauth-token',
        credential: 'oauth_token_that_is_long_enough_to_pass_validation_1234567890',
      } satisfies SaveAgentCredentialRequest);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('not supported');
    });

    it('should reject unknown agents through schema validation', async () => {
      const res = await putAgentCredential(app, {
        agentType: 'unknown-agent',
        credentialKind: 'api-key',
        credential: 'opaque-key',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/credentials/agent - Multiple credential types', () => {
    it('should return both API key and OAuth token with active flags', async () => {
      const mockCredentials = [
        {
          agentType: 'claude-code',
          provider: 'anthropic',
          credentialKind: 'api-key',
          isActive: false,
          encryptedToken: 'encrypted-api-key',
          iv: 'iv1',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
        {
          agentType: 'claude-code',
          provider: 'anthropic',
          credentialKind: 'oauth-token',
          isActive: true,
          encryptedToken: 'encrypted-oauth-token',
          iv: 'iv2',
          createdAt: '2024-01-02',
          updatedAt: '2024-01-02',
        },
      ];

      mockDB.where.mockResolvedValueOnce(mockCredentials);

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'GET',
        },
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.credentials).toHaveLength(2);
      expect(body.credentials[0].credentialKind).toBe('api-key');
      expect(body.credentials[0].isActive).toBe(false);
      expect(body.credentials[1].credentialKind).toBe('oauth-token');
      expect(body.credentials[1].isActive).toBe(true);
      expect(body.credentials[1].label).toBe('Pro/Max Subscription');
    });
  });

  describe('Auto-activation behavior', () => {
    it('should not auto-activate when autoActivate is false', async () => {
      mockDB.limit.mockResolvedValueOnce([]);

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'oauth_token_that_is_long_enough_for_validation_1234567890',
        autoActivate: false,
      };

      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        makeTestEnv()
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isActive).toBe(false);

      // Verify no deactivation of other credentials
      expect(mockDB.update).not.toHaveBeenCalled();
    });

    it('should update existing credential of same type and kind', async () => {
      // Mock existing credential of same type
      mockDB.limit.mockResolvedValueOnce([
        {
          id: 'existing-id',
          agentType: 'claude-code',
          credentialKind: 'oauth-token',
          createdAt: '2024-01-01',
        },
      ]);

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'updated_oauth_token_that_is_long_enough_for_validation_1234567890',
        autoActivate: true,
      };

      const env = makeTestEnv();
      const res = await app.request(
        '/api/credentials/agent',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        env
      );

      expect(res.status).toBe(200); // Update returns 200, not 201

      // Existing-credential path now prepares an UPDATE (not INSERT) via raw DATABASE.
      const database = env.DATABASE as unknown as { prepare: ReturnType<typeof vi.fn> };
      const prepareCalls = database.prepare.mock.calls.map((c) => c[0] as string);
      const updateSql = prepareCalls.find(
        (sql) => sql.includes('UPDATE credentials') && sql.includes('encrypted_token')
      );
      expect(updateSql).toBeDefined();
      const insertSql = prepareCalls.find((sql) => sql.includes('INSERT INTO credentials'));
      expect(insertSql).toBeUndefined();
    });
  });
});
