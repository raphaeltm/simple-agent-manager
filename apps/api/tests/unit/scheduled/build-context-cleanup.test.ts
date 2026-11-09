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
});
afterEach(() => sqlite.close());
describe('context bundle retention', () => {
  it('crosses multiple R2 pages and preserves active/young/unrelated objects', async () => {
    const now = new Date('2026-11-09T00:00:00Z');
    const objects = ['active', 'terminal', 'orphan', 'young', 'another'].map((name) => ({
      key: prefix + name + '/1.tar.zst',
      size: 100,
      uploaded: new Date(name === 'young' ? now.getTime() : now.getTime() - 72 * 3600000),
    }));
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
    expect(await runBuildContextCleanup(env, now)).toEqual({ scanned: 5, deleted: 3, bytes: 300 });
    expect(list).toHaveBeenCalledTimes(3);
    expect(deleted).toEqual(
      ['terminal', 'orphan', 'another'].map((n) => prefix + n + '/1.tar.zst')
    );
    expect(await kv.get('cleanup:compose-build-contexts:cursor')).toBeNull();
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
