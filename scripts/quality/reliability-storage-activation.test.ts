import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Database = requireFromApi('better-sqlite3');
import { describe, expect, it, vi } from 'vitest';

import {
  activateStorage,
  ACTIVATION_KEY,
  INSERT_ACTIVATION,
  verifyLiveVersion,
} from '../deploy/reliability-storage-activation.mjs';

const sha = 'a'.repeat(40);
function live() {
  const deployment = { versions: [{ version_id: 'version-one', percentage: 100 }] };
  const version = {
    id: 'version-one',
    annotations: { 'workers/message': `commit:${sha}` },
    resources: {
      bindings: [
        { name: 'DATABASE', type: 'd1', id: 'primary-db' },
        { name: 'MCP_RATE_COUNTER', type: 'durable_object_namespace' },
        { name: 'WORKSPACE_BOOT_LOG', type: 'durable_object_namespace' },
      ],
    },
  };
  return { deployment, version };
}
function fixture() {
  let record: unknown = null;
  const query = vi.fn(async (_db, sql, params) => {
    if (sql === INSERT_ACTIVATION)
      record ??= {
        publishedAt: 100,
        rateCutoverAt: params[1],
        bootLogCutoverAt: params[1],
        windowSeconds: params[2],
      };
    return {
      results: sql === INSERT_ACTIVATION ? [] : record ? [{ value: JSON.stringify(record) }] : [],
    };
  });
  const verifyLive = vi.fn(async () => ({ database: 'primary-db', windowSeconds: 60 }));
  return { query, verifyLive, cutover: 180, publish: true, now: () => 100 };
}
describe('deployment-owned reliability activation', () => {
  it('verifies actual deployed SHA, 100% version and both compatible bindings', () => {
    const { deployment, version } = live();
    expect(verifyLiveVersion(deployment, version, sha, 'version-one')).toEqual({
      database: 'primary-db',
      windowSeconds: 60,
    });
    expect(() => verifyLiveVersion(deployment, version, 'b'.repeat(40), 'version-one')).toThrow();
    deployment.versions[0].percentage = 50;
    expect(() => verifyLiveVersion(deployment, version, sha, 'version-one')).toThrow();
    deployment.versions[0].percentage = 100;
    version.resources.bindings.pop();
    expect(() => verifyLiveVersion(deployment, version, sha, 'version-one')).toThrow();
  });
  it('preflight reads without writing and does not pretend to prove write authority', async () => {
    const f = fixture();
    expect((await activateStorage({ ...f, publish: false })).outcome).toBe('preflight');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0][1]).toMatch(/^SELECT/);
  });
  it('publishes once with exact readback; identical retry does not mutate', async () => {
    const f = fixture();
    const first = await activateStorage(f);
    expect(first.outcome).toBe('published');
    expect((await activateStorage({ ...f, now: () => 999 })).record).toEqual(first.record);
    expect(f.query.mock.calls.filter((call) => call[1] === INSERT_ACTIVATION)).toHaveLength(1);
    await expect(activateStorage({ ...f, cutover: 240 })).rejects.toThrow('Conflicting');
  });
  it('fails on expired/unaligned cutovers and on changed live configuration before publication', async () => {
    const f = fixture();
    await expect(activateStorage({ ...f, cutover: 120, now: () => 120 })).rejects.toThrow('future');
    await expect(activateStorage({ ...f, cutover: 181 })).rejects.toThrow('align');
    f.verifyLive
      .mockResolvedValueOnce({ database: 'primary-db', windowSeconds: 60 })
      .mockResolvedValueOnce({ database: 'other-db', windowSeconds: 60 });
    await expect(activateStorage(f)).rejects.toThrow('changed');
    expect(f.query.mock.calls.every((call) => call[1].startsWith('SELECT'))).toBe(true);
  });
  it('rejects unconfirmed and conflicting publication readback', async () => {
    const f = fixture();
    f.query.mockResolvedValue({ results: [] });
    await expect(activateStorage(f)).rejects.toThrow('not confirmed');
    f.query.mockResolvedValue({
      results: [
        {
          value: JSON.stringify({
            publishedAt: 100,
            rateCutoverAt: 240,
            bootLogCutoverAt: 240,
            windowSeconds: 60,
          }),
        },
      ],
    });
    await expect(activateStorage(f)).rejects.toThrow('Conflicting');
  });
  it('uses an atomic insert that cannot overwrite, rejects expired boundaries in SQL', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const cutover = Math.ceil((Date.now() / 1000 + 120) / 60) * 60;
      expect(
        db.prepare(INSERT_ACTIVATION).run({ 1: ACTIVATION_KEY, 2: cutover, 3: 60 }).changes
      ).toBe(1);
      expect(
        db.prepare(INSERT_ACTIVATION).run({ 1: ACTIVATION_KEY, 2: cutover + 60, 3: 60 }).changes
      ).toBe(0);
      expect(
        JSON.parse(
          (db.prepare('SELECT value FROM platform_settings').get() as { value: string }).value
        ).rateCutoverAt
      ).toBe(cutover);
      db.exec('DELETE FROM platform_settings');
      expect(db.prepare(INSERT_ACTIVATION).run({ 1: ACTIVATION_KEY, 2: 60, 3: 60 }).changes).toBe(
        0
      );
      for (const [timestamp, window] of [
        [cutover + 0.5, 60],
        [String(cutover), 60],
        [cutover, 60.5],
      ]) {
        expect(
          db.prepare(INSERT_ACTIVATION).run({ 1: ACTIVATION_KEY, 2: timestamp, 3: window }).changes
        ).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});
