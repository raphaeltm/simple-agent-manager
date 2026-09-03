import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { ProjectDataManualToolPayloadCleanupStateError } from '../../../src/durable-objects/project-data/tool-payload-manual-cleanup';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () =>
    vi.fn(
      (
        c: {
          req: { header: (name: string) => string | undefined };
          json: (body: unknown, status: 403) => Response;
        },
        next: () => Promise<void>
      ) =>
        c.req.header('x-test-role') === 'superadmin'
          ? next()
          : c.json({ error: 'FORBIDDEN', message: 'Superadmin access required' }, 403)
    ),
}));

const { requireAuth, requireApproved, requireSuperadmin } =
  await import('../../../src/middleware/auth');
const { adminProjectDataStorageRoutes } =
  await import('../../../src/routes/admin/project-data-storage');

function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use(
    '/api/admin/project-data/storage/*',
    requireAuth(),
    requireApproved(),
    requireSuperadmin()
  );
  app.route('/api/admin/project-data/storage', adminProjectDataStorageRoutes);
  return app;
}

function makeManualCleanupResult(projectId: string) {
  return {
    version: 1,
    projectId,
    reason: 'operator incident gate',
    idempotencyKey: 'manual-key-1',
    idempotent: false,
    attempted: true,
    skipReason: null,
    startedAt: 1000,
    completedAt: 1100,
    budgets: {
      batchRows: 2,
      batchBytes: 1024,
      wallTimeMs: 500,
      maxBatchRows: 5,
      maxBatchBytes: 4096,
      maxWallTimeMs: 1000,
      recheckMs: 86_400_000,
    },
    cooldown: {
      active: true,
      nextAllowedAt: 86_401_000,
      remainingMs: 86_399_900,
      recheckMs: 86_400_000,
    },
    telemetry: {
      beforeBytes: 2000,
      afterBytes: 1000,
      reclaimedBytes: 1000,
      terminationReason: 'target_reached',
      rowsScanned: 2,
      rowsUpdated: 2,
      rowsFailed: 0,
      sessionsScanned: 1,
      originalToolMetadataBytes: 1500,
      storedToolMetadataBytes: 200,
      exhaustedCandidates: false,
      cursor: null,
      recheckAt: null,
    },
    cleanup: null,
  };
}

function makeEnv(
  projectId: string,
  stubOverrides: Record<string, unknown> = {},
  envOverrides: Partial<Env> = {}
): Env {
  const stub = {
    ensureProjectId: vi.fn(async () => undefined),
    runManualToolPayloadCleanup: vi.fn(async () => makeManualCleanupResult(projectId)),
    ...stubOverrides,
  };
  return {
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
    PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS: '5',
    PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_BYTES: '4096',
    PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_WALL_TIME_MS: '1000',
    PROJECT_DATA: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stub),
    },
    ...envOverrides,
  } as unknown as Env;
}

describe('admin ProjectData manual tool-payload cleanup route', () => {
  it('rejects non-superadmins before touching ProjectData', async () => {
    const projectDataGet = vi.fn();
    const env = {
      PROJECT_DATA: {
        idFromName: vi.fn((name: string) => name),
        get: projectDataGet,
      },
    } as unknown as Env;

    const response = await createApp().request(
      '/api/admin/project-data/storage/project-route/tool-payload-cleanup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'user' },
        body: JSON.stringify({ reason: 'incident', idempotencyKey: 'key-1' }),
      },
      env
    );

    expect(response.status).toBe(403);
    expect(projectDataGet).not.toHaveBeenCalled();
  });

  it('requires an audit reason and idempotency key', async () => {
    const env = makeEnv('project-route');

    const response = await createApp().request(
      '/api/admin/project-data/storage/project-route/tool-payload-cleanup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({ reason: 'incident' }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(env.PROJECT_DATA.get as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('rejects budgets above env-backed hard maximums before the DO call', async () => {
    const env = makeEnv(
      'project-route',
      {},
      {
        PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS: '3',
      }
    );

    const response = await createApp().request(
      '/api/admin/project-data/storage/project-route/tool-payload-cleanup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({
          reason: 'incident relief',
          idempotencyKey: 'key-1',
          batchRows: 4,
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'BAD_REQUEST',
      message: 'batchRows must be between 1 and 3',
    });
    expect(env.PROJECT_DATA.get as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('delegates exactly one project-scoped cleanup pass while automatic cleanup is disabled', async () => {
    const projectId = 'project-route';
    const env = makeEnv(projectId);

    const response = await createApp().request(
      `/api/admin/project-data/storage/${projectId}/tool-payload-cleanup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({
          reason: ' operator incident gate ',
          idempotencyKey: ' manual-key-1 ',
          batchRows: 2,
          batchBytes: 1024,
          wallTimeMs: 500,
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(env.PROJECT_DATA.idFromName).toHaveBeenCalledWith(projectId);
    const stub = (env.PROJECT_DATA.get as unknown as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;
    expect(stub.ensureProjectId).toHaveBeenCalledWith(projectId);
    expect(stub.runManualToolPayloadCleanup).toHaveBeenCalledWith({
      reason: 'operator incident gate',
      idempotencyKey: 'manual-key-1',
      batchRows: 2,
      batchBytes: 1024,
      wallTimeMs: 500,
    });
    expect(await response.json()).toMatchObject({
      result: {
        projectId,
        attempted: true,
        cooldown: { active: true },
        telemetry: { reclaimedBytes: 1000, rowsUpdated: 2 },
      },
    });
  });

  it('maps manual cleanup idempotency conflicts to HTTP 409', async () => {
    const env = makeEnv('project-route', {
      runManualToolPayloadCleanup: vi.fn(async () => {
        throw new ProjectDataManualToolPayloadCleanupStateError(
          'idempotency_conflict',
          'idempotencyKey was already used with different manual cleanup input'
        );
      }),
    });

    const response = await createApp().request(
      '/api/admin/project-data/storage/project-route/tool-payload-cleanup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'superadmin' },
        body: JSON.stringify({
          reason: 'incident relief',
          idempotencyKey: 'key-conflict',
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'CONFLICT',
      message: 'idempotencyKey was already used with different manual cleanup input',
    });
  });
});
