import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: async (_env: unknown, key: string) =>
    key.endsWith('Hours') ? 48 : key.endsWith('PageSize') ? 2 : 10000,
}));
const { runBuildContextCleanup } = await import('../../../src/scheduled/build-context-cleanup');
let sqlite: Database.Database;
const prefix = 'compose-build-contexts/project/env/';
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.deploymentPublishJobs]);
  sqlite
    .prepare(
      "INSERT INTO deployment_publish_jobs(id,executor,status,context_r2_key) VALUES('active','cloudflare','context_ready',?)"
    )
    .run(prefix + 'active/1.tar.zst');
  sqlite
    .prepare(
      "INSERT INTO deployment_publish_jobs(id,executor,status,context_r2_key) VALUES('terminal','cloudflare','succeeded',?),('node-active','node','context_ready',?)"
    )
    .run(prefix + 'terminal/1.tar.zst', prefix + 'node-active/1.tar.zst');
});
afterEach(() => {
  sqlite.close();
  vi.useRealTimers();
});
describe('context bundle retention', () => {
  it('crosses multiple R2 pages and preserves active/young/unrelated objects', async () => {
    const now = new Date('2026-11-09T00:00:00Z');
    const objects = ['active', 'terminal', 'orphan', 'young', 'another', 'node-active'].map(
      (name) => ({
        key: prefix + name + '/1.tar.zst',
        size: 100,
        uploaded: new Date(name === 'young' ? now.getTime() : now.getTime() - 72 * 3600000),
      })
    );
    const deleted: string[] = [];
    const list = vi.fn(
      async ({
        prefix: requested,
        cursor,
        limit,
      }: {
        prefix: string;
        cursor?: string;
        limit: number;
      }) => {
        expect(requested).toBe('compose-build-contexts/');
        expect(limit).toBe(2);
        const i = Number(cursor ?? 0);
        return {
          objects: objects.slice(i, i + 2),
          truncated: i + 2 < objects.length,
          cursor: String(i + 2),
        };
      }
    );
    const kv = createMemoryKv();
    const env = {
      DATABASE: createSqliteD1(sqlite),
      KV: kv,
      R2: {
        list,
        delete: async (key: string) => {
          deleted.push(key);
        },
      },
    } as unknown as Env;
    expect(await runBuildContextCleanup(env, now)).toEqual({
      scanned: 6,
      deleted: 4,
      bytes: 400,
      errors: 0,
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(deleted).toEqual(
      ['terminal', 'orphan', 'another', 'node-active'].map((n) => prefix + n + '/1.tar.zst')
    );
    expect(await kv.get('cleanup:compose-build-contexts:cursor')).toBeNull();
  });
  it('counts a failed delete and continues across later objects and pages', async () => {
    const now = new Date('2026-11-09T00:00:00Z');
    const failed = prefix + 'failed/1.tar.zst';
    const later = prefix + 'later/1.tar.zst';
    const last = prefix + 'last/1.tar.zst';
    const object = (key: string) => ({
      key,
      size: 100,
      uploaded: new Date('2026-11-01T00:00:00Z'),
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [object(failed), object(later)],
        truncated: true,
        cursor: 'next',
      })
      .mockResolvedValueOnce({ objects: [object(last)], truncated: false });
    const remove = vi.fn(async (key: string) => {
      if (key === failed) throw new Error('transient R2 delete failure');
    });
    const kv = createMemoryKv();
    const result = await runBuildContextCleanup(
      { DATABASE: createSqliteD1(sqlite), KV: kv, R2: { list, delete: remove } } as unknown as Env,
      now
    );
    expect(result).toEqual({ scanned: 3, deleted: 2, bytes: 200, errors: 1 });
    expect(remove.mock.calls).toEqual([[failed], [later], [last]]);
    expect(list).toHaveBeenLastCalledWith({
      prefix: 'compose-build-contexts/',
      cursor: 'next',
      limit: 2,
    });
    expect(await kv.get('cleanup:compose-build-contexts:cursor')).toBeNull();
  });
  it('retains the current page cursor on budget exhaustion and resumes remaining objects', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-09T00:00:00Z');
    vi.setSystemTime(now);
    const kv = createMemoryKv();
    const cursorKey = 'cleanup:compose-build-contexts:cursor';
    await kv.put(cursorKey, 'current');
    const removed = new Set<string>();
    const object = (name: string) => ({
      key: prefix + name + '/1.tar.zst',
      size: 100,
      uploaded: new Date('2026-11-01T00:00:00Z'),
    });
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => ({
      objects: (cursor === 'current'
        ? [object('first'), object('second')]
        : [object('third')]
      ).filter((o) => !removed.has(o.key)),
      truncated: cursor === 'current',
      cursor: 'next',
    }));
    const remove = vi.fn(async (key: string) => {
      removed.add(key);
      if (removed.size === 1) vi.setSystemTime(new Date(now.getTime() + 10001));
    });
    const env = {
      DATABASE: createSqliteD1(sqlite),
      KV: kv,
      R2: { list, delete: remove },
    } as unknown as Env;
    expect(await runBuildContextCleanup(env, now)).toEqual({
      scanned: 1,
      deleted: 1,
      bytes: 100,
      errors: 0,
    });
    expect(await kv.get(cursorKey)).toBe('current');
    expect(list).toHaveBeenCalledTimes(1);
    expect(await runBuildContextCleanup(env, now)).toEqual({
      scanned: 2,
      deleted: 2,
      bytes: 200,
      errors: 0,
    });
    expect(list.mock.calls.map(([request]) => request.cursor)).toEqual([
      'current',
      'current',
      'next',
    ]);
    expect(await kv.get(cursorKey)).toBeNull();
    expect(removed).toEqual(new Set(['first', 'second', 'third'].map((name) => object(name).key)));
  });
  it('fails closed if active references cannot be read', async () => {
    sqlite.exec('DROP TABLE deployment_publish_jobs');
    const list = vi.fn();
    await expect(
      runBuildContextCleanup({
        DATABASE: createSqliteD1(sqlite),
        R2: { list },
        KV: createMemoryKv(),
      } as unknown as Env)
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});
