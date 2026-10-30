import { expect, it, vi } from 'vitest';

import { updateAdminSettings } from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('a confirmed losing CAS cannot invalidate the winning writer response', async () => {
  const { env, sqlite } = createAdminSettingsEnv();
  const loserReady = gate(),
    releaseLoser = gate(),
    kvStarted = gate(),
    releaseKv = gate();
  const batch = env.DATABASE.batch.bind(env.DATABASE);
  const get = env.KV.get.bind(env.KV);
  vi.spyOn(env.DATABASE, 'batch').mockImplementation(async (statements) => {
    const result = await batch(statements);
    if (result.length === 3 && result[0]?.meta.changes === 0) {
      loserReady.resolve();
      await releaseLoser.promise;
    }
    return result;
  });
  vi.spyOn(env.KV, 'get').mockImplementation(async (...args: Parameters<typeof env.KV.get>) => {
    const value = await get(...args);
    kvStarted.resolve();
    await releaseKv.promise;
    return value;
  });
  try {
    const writes = [false, true].map((value) =>
      updateAdminSettings(env, {
        actorUserId: 'admin',
        expectedRevision: 0,
        changes: [{ name: 'connector.enabled', value }],
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
    );
    await Promise.all([loserReady.promise, kvStarted.promise]);
    releaseLoser.resolve();
    expect(await writes[1]).toMatchObject({ error: { statusCode: 409 } });
    releaseKv.resolve();
    expect(await writes[0]).toMatchObject({ value: { revision: 1, history: [expect.anything()] } });
  } finally {
    releaseLoser.resolve();
    releaseKv.resolve();
    vi.restoreAllMocks();
    sqlite.close();
  }
});

for (const scenario of ['missing metadata', 'transport failure'] as const) {
  it(`invalidates cached state after an uncertain ${scenario}`, async () => {
    const { env, sqlite } = createAdminSettingsEnv();
    const { resolveAdminSetting } = await import('../../../src/services/admin-settings');
    try {
      expect(await resolveAdminSetting(env, 'connector.enabled')).toBe(true);
      const batch = env.DATABASE.batch.bind(env.DATABASE);
      vi.spyOn(env.DATABASE, 'batch').mockImplementation(async (statements) => {
        const result = await batch(statements);
        if (scenario === 'transport failure') throw new Error('response lost after commit');
        return result.map((entry, index) =>
          index === 0 ? ({ ...entry, meta: undefined } as unknown as D1Result) : entry
        );
      });
      await expect(
        updateAdminSettings(env, {
          actorUserId: 'admin',
          expectedRevision: 0,
          changes: [{ name: 'connector.enabled', value: false }],
        })
      ).rejects.toThrow('Admin settings are unavailable');
      expect(await resolveAdminSetting(env, 'connector.enabled')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      sqlite.close();
    }
  });
}
