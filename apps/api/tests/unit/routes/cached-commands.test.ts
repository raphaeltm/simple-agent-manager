/**
 * Behavioral tests for cached-commands routes.
 *
 * Mounts cachedCommandRoutes on a Hono app, mocks auth + service layer,
 * and verifies HTTP request/response behavior.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../src/index';
import { cachedCommandRoutes } from '../../../src/routes/cached-commands';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'test-user-id',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue(undefined),
}));

const mockGetCachedCommands = vi.fn();
const mockCacheCommands = vi.fn();

vi.mock('../../../src/services/project-data', () => ({
  getCachedCommands: (...args: unknown[]) => mockGetCachedCommands(...args),
  cacheCommands: (...args: unknown[]) => mockCacheCommands(...args),
}));

describe('cached-commands routes', () => {
  let app: Hono<{ Bindings: Env }>;
  const mockEnv = { DATABASE: {} as D1Database } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedCommands.mockResolvedValue([]);
    mockCacheCommands.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const e = err as { statusCode?: number; message?: string };
      return c.json({ message: e.message }, (e.statusCode ?? 500) as 400 | 500);
    });
    app.route('/api/projects/:projectId/cached-commands', cachedCommandRoutes);
  });

  describe('GET /', () => {
    it('returns empty commands array when nothing is cached', async () => {
      const res = await app.request('/api/projects/proj-1/cached-commands', {}, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json<{ commands: unknown[] }>();
      expect(body.commands).toEqual([]);
    });

    it('returns commands from service layer', async () => {
      mockGetCachedCommands.mockResolvedValue([
        { agentType: 'claude-code', name: 'help', description: 'Show help', updatedAt: 1000 },
      ]);
      const res = await app.request('/api/projects/proj-1/cached-commands', {}, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json<{ commands: unknown[] }>();
      expect(body.commands).toHaveLength(1);
    });

    it('passes agentType query param to service', async () => {
      await app.request('/api/projects/proj-1/cached-commands?agentType=claude-code', {}, mockEnv);
      expect(mockGetCachedCommands).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', 'claude-code',
      );
    });

    it('passes undefined when agentType is not provided', async () => {
      await app.request('/api/projects/proj-1/cached-commands', {}, mockEnv);
      expect(mockGetCachedCommands).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', undefined,
      );
    });
  });

  describe('POST /', () => {
    function post(body: unknown, env = mockEnv) {
      return app.request('/api/projects/proj-1/cached-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, env);
    }

    it('returns 400 when agentType is missing', async () => {
      const res = await post({ commands: [] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when commands is not an array', async () => {
      const res = await post({ agentType: 'claude-code', commands: 'not-array' });
      expect(res.status).toBe(400);
    });

    it('filters out commands with empty name', async () => {
      const res = await post({
        agentType: 'claude-code',
        commands: [
          { name: 'help', description: 'Help' },
          { name: '', description: 'Empty name' },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ cached: number }>();
      expect(body.cached).toBe(1);
      expect(mockCacheCommands).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', 'claude-code',
        [{ name: 'help', description: 'Help' }],
      );
    });

    it('trims whitespace from name and description', async () => {
      await post({
        agentType: 'claude-code',
        commands: [{ name: '  compact  ', description: '  Compact context  ' }],
      });
      expect(mockCacheCommands).toHaveBeenCalledWith(
        expect.anything(), 'proj-1', 'claude-code',
        [{ name: 'compact', description: 'Compact context' }],
      );
    });

    it('returns cached count on success', async () => {
      const res = await post({
        agentType: 'claude-code',
        commands: [
          { name: 'help', description: 'Help' },
          { name: 'compact', description: 'Compact' },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ cached: number }>();
      expect(body.cached).toBe(2);
    });

    it('rejects agentType exceeding max length', async () => {
      const res = await post({
        agentType: 'x'.repeat(200),
        commands: [{ name: 'help', description: 'Help' }],
      });
      expect(res.status).toBe(400);
    });
  });
});
