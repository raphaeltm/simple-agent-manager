import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppDeploymentEnv } from '../../../src/env';
import { runBuildContextCleanup } from '../../../src/scheduled/build-context-cleanup';

const cursorKey = 'cleanup:compose-build-contexts:cursor';
const now = new Date('2026-11-13T00:00:00Z');
const object = (name: string) => ({
  key: `compose-build-contexts/project/env/${name}/1.tar.zst`,
  uploaded: new Date('2026-11-01T00:00:00Z'),
  size: 100,
});
const settings = {
  resolveSetting: async (name: string) =>
    name.endsWith('Hours') ? 48 : name.endsWith('PageSize') ? 3 : 10000,
};
function fixture(initial: string | null = null) {
  let checkpoint: string | null = initial;
  const writes: number[] = [];
  const kv = {
    get: async () => checkpoint,
    put: vi.fn(async (_key: string, value: string) => {
      if (writes.some((at) => Date.now() - at < 1000)) throw new Error('KV write limit');
      writes.push(Date.now());
      checkpoint = value;
    }),
    delete: vi.fn(async () => {
      if (writes.some((at) => Date.now() - at < 1000)) throw new Error('KV write limit');
      writes.push(Date.now());
      checkpoint = null;
    }),
  };
  const database = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  return { kv, database };
}
afterEach(() => vi.useRealTimers());
describe('build-context cleanup checkpoints', () => {
  it('advances past slow failed deletes across runs and retries failures on the next sweep', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { kv, database } = fixture();
    const objects = ['a', 'b', 'c', 'd'].map(object);
    const removed = new Set<string>();
    const list = vi.fn(async (options: R2ListOptions) => {
      const remaining = objects.filter(
        (entry) =>
          !removed.has(entry.key) && (!options.startAfter || entry.key > options.startAfter)
      );
      return { objects: remaining.slice(0, 3), truncated: remaining.length > 3, cursor: 'next' };
    });
    const remove = vi.fn(async (key: string) => {
      if (key === objects[0].key || key === objects[1].key) {
        vi.setSystemTime(Date.now() + 6000);
        throw new Error('slow R2 failure');
      }
      removed.add(key);
    });
    const env = {
      DATABASE: database,
      KV: kv,
      R2: { list, delete: remove },
    } as unknown as AppDeploymentEnv;
    expect(await runBuildContextCleanup(env, settings, now)).toEqual({
      scanned: 2,
      deleted: 0,
      bytes: 0,
      errors: 2,
    });
    vi.setSystemTime(Date.now() + 1000);
    expect(await runBuildContextCleanup(env, settings, now)).toEqual({
      scanned: 2,
      deleted: 2,
      bytes: 200,
      errors: 0,
    });
    expect(removed).toEqual(new Set([objects[2].key, objects[3].key]));
    expect(await kv.get()).toBeNull();
    vi.setSystemTime(Date.now() + 1000);
    await runBuildContextCleanup(env, settings, now);
    expect(remove.mock.calls.filter(([key]) => key === objects[0].key)).toHaveLength(2);
  });

  it('writes the shared KV checkpoint only once across fast truncated pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { kv, database } = fixture();
    const list = vi.fn(async ({ cursor }: R2ListOptions) => ({
      objects: [object(cursor ?? 'first')],
      truncated: cursor !== 'last',
      cursor: cursor ? 'last' : 'middle',
    }));
    const env = {
      DATABASE: database,
      KV: kv,
      R2: { list, delete: vi.fn() },
    } as unknown as AppDeploymentEnv;
    expect(await runBuildContextCleanup(env, settings, now)).toEqual({
      scanned: 3,
      deleted: 3,
      bytes: 300,
      errors: 0,
    });
    expect(kv.put.mock.calls.length + kv.delete.mock.calls.length).toBe(1);
    expect(await kv.get()).toBeNull();
  });
  it.each(['{legacy-cursor', '{"opaque":true}'])(
    'preserves opaque legacy cursor %s',
    async (cursor) => {
      const { kv, database } = fixture(cursor);
      const list = vi.fn(async () => ({ objects: [], truncated: false }));
      await runBuildContextCleanup(
        { DATABASE: database, KV: kv, R2: { list } } as unknown as AppDeploymentEnv,
        settings,
        now
      );
      expect(list).toHaveBeenCalledWith({ prefix: 'compose-build-contexts/', cursor, limit: 3 });
    }
  );

  it('checkpoints a failed later page once and resumes it on the next invocation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { kv, database } = fixture();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [object('first')], truncated: true, cursor: 'next' })
      .mockRejectedValueOnce(new Error('list unavailable'))
      .mockResolvedValueOnce({ objects: [object('later')], truncated: false });
    const env = {
      DATABASE: database,
      KV: kv,
      R2: { list, delete: vi.fn() },
    } as unknown as AppDeploymentEnv;
    await expect(runBuildContextCleanup(env, settings, now)).rejects.toThrow('list unavailable');
    expect(kv.put).toHaveBeenCalledExactlyOnceWith(cursorKey, JSON.stringify({ cursor: 'next' }));
    vi.setSystemTime(Date.now() + 1000);
    await runBuildContextCleanup(env, settings, now);
    expect(list).toHaveBeenLastCalledWith({
      prefix: 'compose-build-contexts/',
      cursor: 'next',
      limit: 3,
    });
    expect(await kv.get()).toBeNull();
  });
});
