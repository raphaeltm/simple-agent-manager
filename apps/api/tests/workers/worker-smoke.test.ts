/**
 * Worker smoke tests via SELF.fetch() in the workerd runtime.
 *
 * Tests unauthenticated endpoints and verifies the Worker boots correctly
 * with real Miniflare bindings. Authenticated route tests remain in
 * tests/unit/ with mocked middleware since setting up JWT + D1 user data
 * in Miniflare adds complexity without proportional value.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Worker smoke tests (workerd runtime)', () => {
  describe('health check', () => {
    it('returns healthy status', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health');
      expect(response.status).toBe(200);

      const body = await response.json<{
        status: string;
        version: string;
        timestamp: string;
        limits: Record<string, number>;
      }>();
      expect(body.status).toBe('healthy');
      expect(body.version).toBe('0.1.0-test');
      expect(body.timestamp).toBeTruthy();
      expect(body.limits).toBeDefined();
    });

    it('returns runtime limits from env bindings', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health');
      const body = await response.json<{
        limits: Record<string, number>;
      }>();

      expect(body.limits.maxNodesPerUser).toBe(10);
      expect(body.limits.maxWorkspacesPerUser).toBe(10);
      expect(body.limits.maxProjectsPerUser).toBe(50);
    });
  });

  describe('404 handler', () => {
    it('returns NOT_FOUND for unknown routes', async () => {
      const response = await SELF.fetch(
        'https://api.test.example.com/api/nonexistent'
      );
      expect(response.status).toBe(404);

      const body = await response.json<{ error: string; message: string }>();
      expect(body.error).toBe('NOT_FOUND');
    });
  });

  describe('CORS', () => {
    it('includes CORS headers for same-domain origin', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        headers: { Origin: 'https://app.test.example.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://app.test.example.com'
      );
    });

    it('handles OPTIONS preflight requests', async () => {
      const response = await SELF.fetch('https://api.test.example.com/health', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.test.example.com',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
        },
      });
      // CORS preflight should succeed
      expect(response.status).toBeLessThan(400);
    });
  });

  describe('authenticated routes require auth', () => {
    it('returns 401 for /api/projects without auth', async () => {
      const response = await SELF.fetch(
        'https://api.test.example.com/api/projects'
      );
      expect(response.status).toBe(401);
    });

    it('returns 401 for /api/workspaces without auth', async () => {
      const response = await SELF.fetch(
        'https://api.test.example.com/api/workspaces'
      );
      expect(response.status).toBe(401);
    });

    it('returns 401 for /api/nodes without auth', async () => {
      const response = await SELF.fetch(
        'https://api.test.example.com/api/nodes'
      );
      expect(response.status).toBe(401);
    });
  });

  describe('D1 binding', () => {
    it('D1 database binding is available', async () => {
      // The env.DATABASE binding should be a D1 database
      expect(env.DATABASE).toBeDefined();
      // Verify we can execute a simple query
      const result = await env.DATABASE.prepare('SELECT 1 as val').first();
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).val).toBe(1);
    });
  });

  describe('KV binding', () => {
    it('KV namespace binding is available', async () => {
      expect(env.KV).toBeDefined();
      await env.KV.put('test-key', 'test-value');
      const value = await env.KV.get('test-key');
      expect(value).toBe('test-value');
    });
  });

  describe('Durable Object binding', () => {
    it('PROJECT_DATA namespace is available', async () => {
      expect(env.PROJECT_DATA).toBeDefined();
      const id = env.PROJECT_DATA.idFromName('smoke-test-project');
      expect(id).toBeDefined();
      expect(id.toString()).toBeTruthy();
    });
  });
});
