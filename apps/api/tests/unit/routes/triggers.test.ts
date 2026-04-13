/**
 * Unit tests for trigger route validation logic.
 *
 * Tests request validation by mocking auth, project ownership, and DB layers,
 * then making HTTP requests through the Hono router.
 *
 * These tests focus on input validation (which happens before DB queries)
 * since complex drizzle query mocking is fragile. DB-dependent behavior
 * is covered by the cron-sweep and trigger-submit service tests.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// =============================================================================
// Mocks
// =============================================================================

// Mock auth middleware — pass through, inject auth context
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'test-user-id', name: 'Test User', email: 'test@example.com' } });
    return next();
  }),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getAuth: (c: any) => c.get('auth') ?? { user: { id: 'test-user-id' } },
  getUserId: () => 'test-user-id',
}));

// Mock project auth — always succeeds and returns a project
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'test-user-id',
    name: 'Test Project',
    repository: 'user/repo',
    installationId: 'install-1',
    defaultBranch: 'main',
  }),
}));

// Mock the cron utilities
const mockValidateCron = vi.fn().mockReturnValue({ valid: true, humanReadable: 'Every day at 9:00 AM' });
vi.mock('../../../src/services/cron-utils', () => ({
  validateCronExpression: (...args: any[]) => mockValidateCron(...args),
  cronToNextFire: vi.fn().mockReturnValue('2026-04-10T09:00:00.000Z'),
  cronToHumanReadable: vi.fn().mockReturnValue('Every day at 9:00 AM (UTC)'),
}));

// Mock the template engine
vi.mock('../../../src/services/trigger-template', () => ({
  renderTemplate: vi.fn().mockReturnValue({ rendered: 'Review PRs for Daily Review', warnings: [] }),
  buildCronContext: vi.fn().mockReturnValue({}),
}));

// Mock submitTriggeredTask
vi.mock('../../../src/services/trigger-submit', () => ({
  submitTriggeredTask: vi.fn().mockResolvedValue({
    taskId: 'task-001',
    sessionId: 'session-001',
    branchName: 'sam/daily-review-abc123',
  }),
}));

// Mock ulid
let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `ULID${String(++ulidCounter).padStart(6, '0')}`,
}));

// Mock logger
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// =============================================================================
// DB mock — configurable per-query response queue
// =============================================================================

/** Queue of results for sequential DB queries. Each query pops the first item. */
let queryResults: any[][] = [];

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => {
    function makeThenable(resolveValue: () => Promise<any>) {
      const obj: any = {
        where: vi.fn(() => makeThenable(resolveValue)),
        orderBy: vi.fn(() => makeThenable(resolveValue)),
        limit: vi.fn((n: number) => {
          return makeThenable(async () => {
            const data = await resolveValue();
            return data.slice(0, n);
          });
        }),
        offset: vi.fn(() => makeThenable(resolveValue)),
        then: (resolve: any, reject?: any) => resolveValue().then(resolve, reject),
      };
      return obj;
    }

    return {
      select: vi.fn(() => ({
        from: vi.fn(() => makeThenable(() => Promise.resolve(queryResults.shift() || []))),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.resolve()),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    };
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: any, val: any) => ['eq', val]),
  and: vi.fn((...args: any[]) => ['and', ...args]),
  count: vi.fn(() => 'count'),
  desc: vi.fn((col: any) => col),
  inArray: vi.fn((_col: any, vals: any) => ['inArray', vals]),
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
  lte: vi.fn((_col: any, val: any) => ['lte', val]),
}));

// =============================================================================
// Setup
// =============================================================================

import { triggersRoutes } from '../../../src/routes/triggers';

const ROUTE_PATH = '/api/projects/:projectId/triggers';
const REQUEST_PATH = '/api/projects/test-project-id/triggers';

const env: Env = {
  DATABASE: {} as any,
  CRON_TEMPLATE_MAX_LENGTH: undefined,
  MAX_TRIGGERS_PER_PROJECT: undefined,
  CRON_MIN_INTERVAL_MINUTES: undefined,
} as Env;

describe('Trigger Routes', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    ulidCounter = 0;
    queryResults = [];

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode as any);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: (err as Error).message }, 500);
    });
    app.route(ROUTE_PATH, triggersRoutes);
  });

  // =============================================================================
  // POST / — Create trigger
  // =============================================================================
  describe('POST / — Create trigger', () => {
    it('creates a cron trigger successfully', async () => {
      // Queue: name uniqueness check, trigger count, read-back after insert
      queryResults = [
        [],                        // name uniqueness: no existing trigger with same name
        [{ count: 0 }],           // trigger count: below limit
        [{                         // read-back of created trigger
          id: 'ULID000001',
          projectId: 'test-project-id',
          userId: 'test-user-id',
          name: 'Daily Review',
          description: null,
          status: 'active',
          sourceType: 'cron',
          cronExpression: '0 9 * * *',
          cronTimezone: 'UTC',
          skipIfRunning: true,
          promptTemplate: 'Review PRs for today',
          agentProfileId: null,
          taskMode: 'task',
          vmSizeOverride: null,
          maxConcurrent: 1,
          nextFireAt: '2026-04-10T09:00:00.000Z',
          lastTriggeredAt: null,
          triggerCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      ];

      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Daily Review',
            sourceType: 'cron',
            cronExpression: '0 9 * * *',
            promptTemplate: 'Review PRs for today',
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.name).toBe('Daily Review');
      expect(json.status).toBe('active');
      expect(json.sourceType).toBe('cron');
      expect(json.cronExpression).toBe('0 9 * * *');
      expect(json.cronHumanReadable).toBeDefined();
    });

    it('rejects non-cron source type', async () => {
      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Webhook Trigger',
            sourceType: 'webhook',
            promptTemplate: 'Handle webhook',
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain('Only cron');
    });

    it('rejects missing cron expression for cron source', async () => {
      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'No Cron',
            sourceType: 'cron',
            promptTemplate: 'Do something',
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain('cronExpression is required');
    });

    it('rejects empty name', async () => {
      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '   ',
            sourceType: 'cron',
            cronExpression: '0 9 * * *',
            promptTemplate: 'Do stuff',
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain('name is required');
    });

    it('rejects empty prompt template', async () => {
      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test',
            sourceType: 'cron',
            cronExpression: '0 9 * * *',
            promptTemplate: '   ',
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain('promptTemplate is required');
    });

    it('rejects invalid cron expression', async () => {
      mockValidateCron.mockReturnValueOnce({ valid: false, error: 'Invalid cron: bad expression' });

      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad Cron',
            sourceType: 'cron',
            cronExpression: 'not a cron',
            promptTemplate: 'Do stuff',
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toContain('Invalid cron');
    });

    it('rejects duplicate trigger name', async () => {
      // Queue: name uniqueness check returns existing trigger
      queryResults = [
        [{ id: 'existing-trigger' }],  // name conflict
      ];

      const res = await app.request(
        REQUEST_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Daily Review',
            sourceType: 'cron',
            cronExpression: '0 9 * * *',
            promptTemplate: 'Review PRs',
          }),
        },
        env
      );

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.message).toContain('already exists');
    });
  });

  // =============================================================================
  // GET / — List triggers
  // =============================================================================
  describe('GET / — List triggers', () => {
    it('returns an empty list for project with no triggers', async () => {
      // Queue: trigger list query returns empty, count returns 0
      queryResults = [
        [],              // triggers list
        [{ count: 0 }], // total count
      ];

      const res = await app.request(
        REQUEST_PATH,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.triggers).toEqual([]);
    });
  });

  // =============================================================================
  // GET /:triggerId — Get trigger details
  // =============================================================================
  describe('GET /:triggerId — Get trigger details', () => {
    it('returns 404 for nonexistent trigger', async () => {
      // Queue: trigger lookup returns empty
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/nonexistent`,
        { method: 'GET' },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  // =============================================================================
  // POST /:triggerId/test — Dry-run
  // =============================================================================
  describe('POST /:triggerId/test — Dry-run', () => {
    it('returns 404 for nonexistent trigger', async () => {
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/nonexistent/test`,
        { method: 'POST' },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  // =============================================================================
  // POST /:triggerId/run — Manual fire
  // =============================================================================
  describe('POST /:triggerId/run — Manual fire', () => {
    it('returns 404 for nonexistent trigger', async () => {
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/nonexistent/run`,
        { method: 'POST' },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  // =============================================================================
  // DELETE /:triggerId — Delete trigger
  // =============================================================================
  describe('DELETE /:triggerId — Delete trigger', () => {
    it('returns 404 for nonexistent trigger', async () => {
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/nonexistent`,
        { method: 'DELETE' },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  // =============================================================================
  // DELETE /:triggerId/executions/:executionId — Delete single execution
  // =============================================================================
  describe('DELETE /:triggerId/executions/:executionId — Delete execution', () => {
    it('returns 404 when execution does not exist', async () => {
      // Queue: execution lookup (empty — no trigger lookup since requireOwnedProject is mocked)
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/exec-missing`,
        { method: 'DELETE' },
        env
      );

      expect(res.status).toBe(404);
    });

    it('returns 409 when execution is running', async () => {
      // Queue: execution lookup (running)
      queryResults = [
        [{ id: 'exec-1', status: 'running', triggerId: 'trigger-1', projectId: 'test-project-id' }],
      ];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/exec-1`,
        { method: 'DELETE' },
        env
      );

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.message).toContain('running');
    });

    it('deletes a completed execution successfully', async () => {
      // Queue: execution lookup (completed)
      queryResults = [
        [{ id: 'exec-1', status: 'completed', triggerId: 'trigger-1', projectId: 'test-project-id' }],
      ];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/exec-1`,
        { method: 'DELETE' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });

    it('deletes a queued execution successfully', async () => {
      // Queue: execution lookup (queued)
      queryResults = [
        [{ id: 'exec-2', status: 'queued', triggerId: 'trigger-1', projectId: 'test-project-id' }],
      ];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/exec-2`,
        { method: 'DELETE' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });
  });

  // =============================================================================
  // POST /:triggerId/executions/cleanup — Force-fail stuck queued executions
  // =============================================================================
  describe('POST /:triggerId/executions/cleanup — Cleanup stuck executions', () => {
    it('returns 404 when trigger does not exist', async () => {
      queryResults = [[]];

      const res = await app.request(
        `${REQUEST_PATH}/nonexistent/executions/cleanup`,
        { method: 'POST' },
        env
      );

      expect(res.status).toBe(404);
    });

    it('returns cleaned: 0 when no stuck executions exist', async () => {
      // Queue: trigger lookup, stuck execution query (empty)
      queryResults = [
        [{ id: 'trigger-1', projectId: 'test-project-id' }],
        [],
      ];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/cleanup`,
        { method: 'POST' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.cleaned).toBe(0);
    });

    it('cleans up queued executions and returns count', async () => {
      // Queue: trigger lookup, stuck execution query (2 queued)
      queryResults = [
        [{ id: 'trigger-1', projectId: 'test-project-id' }],
        [
          { id: 'exec-1', status: 'queued' },
          { id: 'exec-2', status: 'queued' },
        ],
      ];

      const res = await app.request(
        `${REQUEST_PATH}/trigger-1/executions/cleanup`,
        { method: 'POST' },
        env
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.cleaned).toBe(2);
    });
  });
});
