import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// Mock auth middleware
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getAuth: () => ({ user: { id: 'test-user-id' } }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue({
    id: 'test-project-id',
    userId: 'test-user-id',
  }),
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({}),
}));

const mockProjectDataService = vi.hoisted(() => ({
  getMissionStateEntries: vi.fn(),
  getHandoffPackets: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => mockProjectDataService);

import { missionRoutes } from '../../../src/routes/missions';

const BASE_URL = 'https://api.test.example.com';
const ROUTE_PATH = '/api/projects/:projectId/missions';
const REQUEST_PATH = '/api/projects/test-project-id/missions';

function makeMockD1(overrides: {
  prepareResult?: Record<string, unknown>[] | null;
  firstResult?: Record<string, unknown> | null;
} = {}) {
  const mockFirst = vi.fn().mockResolvedValue(overrides.firstResult ?? null);
  const mockAll = vi.fn().mockResolvedValue({
    results: overrides.prepareResult ?? [],
  });
  const mockBind = vi.fn().mockReturnValue({ first: mockFirst, all: mockAll });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
  return { prepare: mockPrepare, _bind: mockBind, _first: mockFirst, _all: mockAll };
}

function makeEnv(dbOverrides: Parameters<typeof makeMockD1>[0] = {}): Env {
  return {
    DATABASE: makeMockD1(dbOverrides) as any,
    PROJECT_DATA: {
      idFromName: vi.fn().mockReturnValue('do-id-1'),
      get: vi.fn().mockReturnValue({}),
    } as any,
    MISSION_LIST_PAGE_SIZE: '',
    MISSION_LIST_MAX_PAGE_SIZE: '',
  } as unknown as Env;
}

function createApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(ROUTE_PATH, missionRoutes);
  // Add error handler to convert AppError to proper HTTP responses
  app.onError((err, c) => {
    if (err && typeof (err as any).statusCode === 'number') {
      return c.json((err as any).toJSON(), (err as any).statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  return {
    fetch: (req: Request) => app.fetch(req, env),
  };
}

describe('Mission REST routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET / — list missions ──────────────────────────────────────────────────

  describe('GET / — list missions', () => {
    it('returns empty list when no missions exist', async () => {
      const env = makeEnv({ prepareResult: [] });
      const app = createApp(env);

      const res = await app.fetch(new Request(`${BASE_URL}${REQUEST_PATH}`));
      expect(res.status).toBe(200);

      const body = await res.json() as { missions: unknown[]; hasMore: boolean };
      expect(body.missions).toEqual([]);
      expect(body.hasMore).toBe(false);
    });

    it('returns missions with correct shape', async () => {
      const missions = [
        {
          id: 'mission-1',
          project_id: 'test-project-id',
          title: 'Test Mission',
          description: 'A test mission',
          status: 'active',
          root_task_id: 'task-1',
          created_at: '2026-04-26T00:00:00Z',
          updated_at: '2026-04-26T01:00:00Z',
        },
      ];
      const env = makeEnv({ prepareResult: missions });
      const app = createApp(env);

      const res = await app.fetch(new Request(`${BASE_URL}${REQUEST_PATH}`));
      expect(res.status).toBe(200);

      const body = await res.json() as { missions: Array<{ id: string; projectId: string; title: string }>; hasMore: boolean };
      expect(body.missions).toHaveLength(1);
      expect(body.missions[0]!.id).toBe('mission-1');
      expect(body.missions[0]!.projectId).toBe('test-project-id');
      expect(body.missions[0]!.title).toBe('Test Mission');
    });

    it('supports status filter', async () => {
      const env = makeEnv({ prepareResult: [] });
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}?status=active`),
      );
      expect(res.status).toBe(200);
      // Verify the query was built with the status filter
      expect(env.DATABASE.prepare).toHaveBeenCalled();
    });

    it('supports limit and offset pagination', async () => {
      const env = makeEnv({ prepareResult: [] });
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}?limit=5&offset=10`),
      );
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /:missionId — mission detail ─────────────────────────────────────

  describe('GET /:missionId — mission detail', () => {
    it('returns 404 when mission not found', async () => {
      const env = makeEnv({ firstResult: null, prepareResult: [] });
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/nonexistent`),
      );
      // The route throws errors.notFound which should result in 404
      expect(res.status).toBe(404);
    });

    it('returns mission detail with task summary', async () => {
      const mockDb = makeMockD1();
      // First prepare().bind().first() call returns the mission
      // Second prepare().bind().all() call returns task summary
      let callCount = 0;
      mockDb.prepare.mockImplementation(() => ({
        bind: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // Mission lookup
            return {
              first: vi.fn().mockResolvedValue({
                id: 'mission-1',
                project_id: 'test-project-id',
                title: 'Mission One',
                description: 'Description',
                status: 'active',
                root_task_id: 'task-1',
                budget_config: null,
                created_at: '2026-04-26T00:00:00Z',
                updated_at: '2026-04-26T01:00:00Z',
              }),
              all: vi.fn(),
            };
          }
          // Task summary
          return {
            first: vi.fn(),
            all: vi.fn().mockResolvedValue({
              results: [
                { status: 'completed', cnt: 3 },
                { status: 'running', cnt: 1 },
              ],
            }),
          };
        }),
      }));

      const env = { ...makeEnv(), DATABASE: mockDb } as unknown as Env;
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/mission-1`),
      );
      expect(res.status).toBe(200);

      const body = await res.json() as { mission: { id: string; taskSummary: Record<string, number> } };
      expect(body.mission.id).toBe('mission-1');
      expect(body.mission.taskSummary).toEqual({ completed: 3, running: 1 });
    });
  });

  // ─── GET /:missionId/state — mission state entries ────────────────────────

  describe('GET /:missionId/state', () => {
    it('returns 404 when mission not found', async () => {
      const env = makeEnv({ firstResult: null });
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/nonexistent/state`),
      );
      expect(res.status).toBe(404);
    });

    it('returns state entries when mission exists', async () => {
      const env = makeEnv({
        firstResult: { id: 'mission-1' }, // mission exists
      });
      mockProjectDataService.getMissionStateEntries.mockResolvedValue([
        { id: 'entry-1', entryType: 'decision', title: 'Use REST' },
      ]);
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/mission-1/state`),
      );
      expect(res.status).toBe(200);

      const body = await res.json() as { entries: Array<{ id: string }> };
      expect(body.entries).toHaveLength(1);
      expect(mockProjectDataService.getMissionStateEntries).toHaveBeenCalledWith(
        env, 'test-project-id', 'mission-1', null,
      );
    });

    it('passes entryType filter to service', async () => {
      const env = makeEnv({
        firstResult: { id: 'mission-1' },
      });
      mockProjectDataService.getMissionStateEntries.mockResolvedValue([]);
      const app = createApp(env);

      await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/mission-1/state?entryType=fact`),
      );
      expect(mockProjectDataService.getMissionStateEntries).toHaveBeenCalledWith(
        env, 'test-project-id', 'mission-1', 'fact',
      );
    });
  });

  // ─── GET /:missionId/handoffs — handoff packets ───────────────────────────

  describe('GET /:missionId/handoffs', () => {
    it('returns 404 when mission not found', async () => {
      const env = makeEnv({ firstResult: null });
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/nonexistent/handoffs`),
      );
      expect(res.status).toBe(404);
    });

    it('returns handoff packets when mission exists', async () => {
      const env = makeEnv({
        firstResult: { id: 'mission-1' },
      });
      mockProjectDataService.getHandoffPackets.mockResolvedValue([
        { id: 'handoff-1', summary: 'Done with API' },
      ]);
      const app = createApp(env);

      const res = await app.fetch(
        new Request(`${BASE_URL}${REQUEST_PATH}/mission-1/handoffs`),
      );
      expect(res.status).toBe(200);

      const body = await res.json() as { handoffs: Array<{ id: string }> };
      expect(body.handoffs).toHaveLength(1);
      expect(mockProjectDataService.getHandoffPackets).toHaveBeenCalledWith(
        env, 'test-project-id', 'mission-1',
      );
    });
  });
});
