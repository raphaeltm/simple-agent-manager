import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { agentSettingsRoutes } from '../../../src/routes/agent-settings';

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

describe('Agent Settings Routes', () => {
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

    app.route('/api/agent-settings', agentSettingsRoutes);

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
    };

    (drizzle as any).mockReturnValue(mockDB);
  });

  describe('GET /api/agent-settings/:agentType', () => {
    it('should return default empty settings when no row exists', async () => {
      mockDB.limit.mockResolvedValueOnce([]);

      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'GET',
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agentType).toBe('claude-code');
      expect(body.model).toBeNull();
      expect(body.permissionMode).toBeNull();
      expect(body.allowedTools).toBeNull();
      expect(body.deniedTools).toBeNull();
      expect(body.additionalEnv).toBeNull();
    });

    it('should return existing settings when row exists', async () => {
      mockDB.limit.mockResolvedValueOnce([{
        id: 'test-id',
        userId: 'test-user-id',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'acceptEdits',
        allowedTools: JSON.stringify(['Read', 'Bash(npm:*)']),
        deniedTools: null,
        additionalEnv: JSON.stringify({ DEBUG: 'true' }),
        createdAt: new Date('2026-02-13T00:00:00Z'),
        updatedAt: new Date('2026-02-13T00:00:00Z'),
      }]);

      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'GET',
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agentType).toBe('claude-code');
      expect(body.model).toBe('claude-opus-4-6');
      expect(body.permissionMode).toBe('acceptEdits');
      expect(body.allowedTools).toEqual(['Read', 'Bash(npm:*)']);
      expect(body.additionalEnv).toEqual({ DEBUG: 'true' });
    });

    it('should reject invalid agent type', async () => {
      const res = await app.request('/api/agent-settings/invalid-agent', {
        method: 'GET',
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('BAD_REQUEST');
      expect(body.message).toContain('Invalid agent type');
    });
  });

  describe('PUT /api/agent-settings/:agentType', () => {
    it('should create settings when none exist', async () => {
      // No existing settings
      mockDB.limit.mockResolvedValueOnce([]);
      // After insert, re-fetch
      mockDB.limit.mockResolvedValueOnce([{
        id: 'test-ulid',
        userId: 'test-user-id',
        agentType: 'claude-code',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        createdAt: new Date('2026-02-13T00:00:00Z'),
        updatedAt: new Date('2026-02-13T00:00:00Z'),
      }]);

      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          permissionMode: 'default',
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.model).toBe('claude-sonnet-4-5-20250929');
      expect(body.permissionMode).toBe('default');
    });

    it('should update settings when they already exist', async () => {
      // Existing settings
      mockDB.limit.mockResolvedValueOnce([{ id: 'existing-id' }]);
      // After update, re-fetch
      mockDB.limit.mockResolvedValueOnce([{
        id: 'existing-id',
        userId: 'test-user-id',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'bypassPermissions',
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        createdAt: new Date('2026-02-13T00:00:00Z'),
        updatedAt: new Date('2026-02-13T01:00:00Z'),
      }]);

      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          permissionMode: 'bypassPermissions',
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.model).toBe('claude-opus-4-6');
      expect(body.permissionMode).toBe('bypassPermissions');
    });

    it('should reject invalid permission mode', async () => {
      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissionMode: 'superAdmin',
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid permission mode');
    });

    it('should reject non-array allowedTools', async () => {
      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowedTools: 'not-an-array',
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('allowedTools must be an array');
    });

    it('should reject non-object additionalEnv', async () => {
      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          additionalEnv: 'not-an-object',
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('additionalEnv must be an object');
    });

    it('should accept null values to clear settings', async () => {
      mockDB.limit.mockResolvedValueOnce([{ id: 'existing-id' }]);
      mockDB.limit.mockResolvedValueOnce([{
        id: 'existing-id',
        userId: 'test-user-id',
        agentType: 'claude-code',
        model: null,
        permissionMode: null,
        allowedTools: null,
        deniedTools: null,
        additionalEnv: null,
        createdAt: new Date('2026-02-13T00:00:00Z'),
        updatedAt: new Date('2026-02-13T01:00:00Z'),
      }]);

      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: null,
          permissionMode: null,
        }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.model).toBeNull();
      expect(body.permissionMode).toBeNull();
    });

    it('should reject invalid agent type', async () => {
      const res = await app.request('/api/agent-settings/not-real', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test' }),
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid agent type');
    });
  });

  describe('DELETE /api/agent-settings/:agentType', () => {
    it('should delete settings successfully', async () => {
      const res = await app.request('/api/agent-settings/claude-code', {
        method: 'DELETE',
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should reject invalid agent type', async () => {
      const res = await app.request('/api/agent-settings/bad-type', {
        method: 'DELETE',
      }, {
        DATABASE: {} as any,
      } as Env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('Invalid agent type');
    });
  });
});
