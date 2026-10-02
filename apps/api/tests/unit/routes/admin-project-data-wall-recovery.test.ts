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
