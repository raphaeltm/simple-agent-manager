import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { credentialsRoutes } from '../../../src/routes/credentials';
import type { SaveAgentCredentialRequest } from '@simple-agent-manager/shared';

// Mock dependencies
vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'test-ulid',
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'encrypted', iv: 'iv' }),
  decrypt: vi.fn().mockResolvedValue('decrypted-credential'),
}));

describe('Credentials Routes - OAuth Support', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;

  beforeEach(() => {
    app = new Hono<{ Bindings: Env }>();

    // Add error handler to match production behavior
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });

    app.route('/api/credentials', credentialsRoutes);

    // Mock database
    mockDB = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };

    (drizzle as any).mockReturnValue(mockDB);
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

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

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

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

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

      // Need to reset and re-mock for the update transaction
      mockDB.where.mockReturnThis();
      mockDB.update.mockReturnThis();
      mockDB.set.mockReturnThis();

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'new_oauth_token_1234567890abcdefghijklmnopqrstuvwxyz_1234567890',
        autoActivate: true,
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(201);

      // Verify update was called to deactivate other credentials
      expect(mockDB.update).toHaveBeenCalled();
      expect(mockDB.set).toHaveBeenCalledWith({ isActive: false });
    });

    it('should save API key when credentialKind is not specified', async () => {
      mockDB.limit.mockResolvedValueOnce([]);

      const request = {
        agentType: 'claude-code',
        credential: 'sk-ant-api03-1234567890abcdef',
        // credentialKind not specified, should default to 'api-key'
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.credentialKind).toBe('api-key');
    });

    it('should reject Claude OAuth token when saved as API key', async () => {
      const request = {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-oat01-1234567890abcdefghijklmnopqrstuvwxyz',
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('OAuth token');
    });

    it('should reject OAuth token for unsupported agents', async () => {
      const request: SaveAgentCredentialRequest = {
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: 'oauth_token_that_is_long_enough_to_pass_validation_1234567890',
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('not supported');
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

      const res = await app.request('/api/credentials/agent', {
        method: 'GET',
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

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

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isActive).toBe(false);

      // Verify no deactivation of other credentials
      expect(mockDB.update).not.toHaveBeenCalled();
    });

    it('should update existing credential of same type and kind', async () => {
      // Mock existing credential of same type
      mockDB.limit.mockResolvedValueOnce([{
        id: 'existing-id',
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        createdAt: '2024-01-01',
      }]);

      const request: SaveAgentCredentialRequest = {
        agentType: 'claude-code',
        credentialKind: 'oauth-token',
        credential: 'updated_oauth_token_that_is_long_enough_for_validation_1234567890',
        autoActivate: true,
      };

      const res = await app.request('/api/credentials/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }, {
        DATABASE: {} as any,
        ENCRYPTION_KEY: 'test-key',
      } as Env);

      expect(res.status).toBe(200); // Update returns 200, not 201

      // Verify update was called on existing credential
      expect(mockDB.update).toHaveBeenCalled();
      expect(mockDB.insert).not.toHaveBeenCalled();
    });
  });
});
