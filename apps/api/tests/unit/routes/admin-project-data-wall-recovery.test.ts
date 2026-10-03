import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createAdminProjectDataStorageApp } from './helpers/admin-project-data-storage-route';

const PROJECT_ID = '01KHRJGANBBWGDY1NZ0KVF0D4J';
const PATH = `/api/admin/project-data/storage/${PROJECT_ID}/grouped-fts-wall-recovery`;
const VALID_BODY = {
  reason: '  wall recovery at 10 GiB  ',
  dryRun: false,
  maxRows: 100,
  maxBytes: 1_000_000,
  maxSessions: 2,
};

function makeEnv(
  runGroupedFtsWallRecovery = vi.fn(async () => ({ stopReason: 'candidates_exhausted' }))
) {
  const stub = {
    ensureProjectId: vi.fn(async () => undefined),
    runGroupedFtsWallRecovery,
  };
  const env = {
    PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS: '100',
    PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES: '1000000',
    PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS: '2',
    PROJECT_DATA: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => stub),
    },
  } as unknown as Env;
  return { env, stub };
}

function post(env: Env, body: unknown, role = 'superadmin') {
  return createAdminProjectDataStorageApp().request(
    PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('POST /api/admin/project-data/storage/:projectId/grouped-fts-wall-recovery', () => {
  it('rejects non-superadmins before touching ProjectData', async () => {
    const { env, stub } = makeEnv();
    const res = await post(env, VALID_BODY, 'user');
    expect(res.status).toBe(403);
    expect(stub.runGroupedFtsWallRecovery).not.toHaveBeenCalled();
  });

  it.each(['dryRun', 'maxRows', 'maxBytes', 'maxSessions', 'reason'] as const)(
    'requires %s',
    async (field) => {
      const { env, stub } = makeEnv();
      const body: Record<string, unknown> = { ...VALID_BODY };
      delete body[field];
      const res = await post(env, body);
      expect(res.status).toBe(400);
      expect(stub.runGroupedFtsWallRecovery).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['maxRows', 101],
    ['maxBytes', 1_000_001],
    ['maxSessions', 3],
  ] as const)('rejects %s above its env ceiling', async (field, value) => {
    const { env, stub } = makeEnv();
    const res = await post(env, { ...VALID_BODY, [field]: value });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(field);
    expect(stub.runGroupedFtsWallRecovery).not.toHaveBeenCalled();
  });

  it('rejects a skip list longer than the session ceiling', async () => {
    const { env, stub } = makeEnv();
    const res = await post(env, { ...VALID_BODY, skipSessionIds: ['a', 'b', 'c'] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('skipSessionIds');
    expect(stub.runGroupedFtsWallRecovery).not.toHaveBeenCalled();
  });

  it('forwards the exact budgets at the ceiling, with an empty skip list by default', async () => {
    const { env, stub } = makeEnv();
    const res = await post(env, VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { stopReason: 'candidates_exhausted' } });
    expect(stub.runGroupedFtsWallRecovery).toHaveBeenCalledWith({
      reason: 'wall recovery at 10 GiB',
      dryRun: false,
      maxRows: 100,
      maxBytes: 1_000_000,
      maxSessions: 2,
      skipSessionIds: [],
    });
  });

  it('forwards skipSessionIds at the ceiling', async () => {
    const { env, stub } = makeEnv();
    const res = await post(env, { ...VALID_BODY, dryRun: true, skipSessionIds: ['s1', 's2'] });
    expect(res.status).toBe(200);
    expect(stub.runGroupedFtsWallRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, skipSessionIds: ['s1', 's2'] })
    );
  });

  it('maps a storage-full DO failure to 507', async () => {
    const { env } = makeEnv(
      vi.fn(async () => {
        throw new Error('Exceeded the maximum database size.');
      })
    );
    const res = await post(env, { ...VALID_BODY, dryRun: true });
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ error: 'PROJECT_DATA_STORAGE_FULL' });
  });
});

describe('GET /api/admin/project-data/storage/grouped-fts-wall-recovery/config', () => {
  const CONFIG_PATH = '/api/admin/project-data/storage/grouped-fts-wall-recovery/config';

  function get(env: Env, role = 'superadmin') {
    return createAdminProjectDataStorageApp().request(
      CONFIG_PATH,
      { headers: { 'x-test-role': role } },
      env
    );
  }

  it('rejects non-superadmins', async () => {
    const { env } = makeEnv();
    expect((await get(env, 'user')).status).toBe(403);
  });

  it('returns the env ceilings and the cautious starting budgets', async () => {
    const env = {
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_ROWS: '10000',
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_BYTES: String(32 * 1024 * 1024),
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_MAX_SESSIONS: '500',
    } as unknown as Env;

    const res = await get(env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ceilings: { maxRows: 10000, maxBytes: 32 * 1024 * 1024, maxSessions: 500 },
      defaults: { maxRows: 500, maxBytes: 4 * 1024 * 1024, maxSessions: 1 },
    });
  });

  it('honours configured starting budgets but never above a ceiling', async () => {
    const { env } = makeEnv(); // ceilings: 100 rows, 1,000,000 bytes, 2 sessions
    Object.assign(env as unknown as Record<string, string>, {
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_DEFAULT_MAX_ROWS: '50',
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_DEFAULT_MAX_BYTES: '9999999',
      PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_DEFAULT_MAX_SESSIONS: '5',
    });

    const body = await (await get(env)).json();

    expect(body).toEqual({
      ceilings: { maxRows: 100, maxBytes: 1_000_000, maxSessions: 2 },
      defaults: { maxRows: 50, maxBytes: 1_000_000, maxSessions: 2 },
    });
  });

  it('does not shadow the per-project archive routes it shares a router with', async () => {
    const { env } = makeEnv();
    // A two-segment literal path must not be captured as `/:projectId/...`.
    const res = await createAdminProjectDataStorageApp().request(
      `/api/admin/project-data/storage/${PROJECT_ID}/grouped-fts-wall-recovery`,
      { method: 'GET', headers: { 'x-test-role': 'superadmin' } },
      env
    );
    expect(res.status).toBe(404);
    expect((await get(env)).status).toBe(200);
  });
});
