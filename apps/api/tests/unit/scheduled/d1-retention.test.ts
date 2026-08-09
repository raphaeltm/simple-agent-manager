import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY,
  DEFAULT_SESSION_SNAPSHOT_PURGE_LAST_RUN_KV_KEY,
  runDeploymentReleaseRetention,
  runScheduledDeploymentReleaseRetention,
  runScheduledSessionSnapshotPurge,
  runSessionSnapshotPurge,
} from '../../../src/scheduled/d1-retention';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('D1 retention sweeps', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.deploymentEnvironments,
      schema.deploymentReleases,
      schema.sessionSnapshots,
    ]);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  function addEnvironment(id: string, observedAppliedSeq: number | null = null): void {
    sqlite
      .prepare('INSERT INTO deployment_environments (id, observed_applied_seq) VALUES (?, ?)')
      .run(id, observedAppliedSeq);
  }

  function addRelease(environmentId: string, version: number, status: string): void {
    sqlite
      .prepare(
        `INSERT INTO deployment_releases (id, environment_id, version, status)
         VALUES (?, ?, ?, ?)`
      )
      .run(`${environmentId}-v${version}`, environmentId, version, status);
  }

  function releaseIds(environmentId: string): string[] {
    return sqlite
      .prepare(
        `SELECT id FROM deployment_releases
         WHERE environment_id = ?
         ORDER BY version ASC`
      )
      .all(environmentId)
      .map((row) => (row as { id: string }).id);
  }

  function addSnapshot(id: string, expiresAt: string): void {
    sqlite
      .prepare('INSERT INTO session_snapshots (id, expires_at) VALUES (?, ?)')
      .run(id, expiresAt);
  }

  function snapshotIds(): string[] {
    return sqlite
      .prepare('SELECT id FROM session_snapshots ORDER BY id ASC')
      .all()
      .map((row) => (row as { id: string }).id);
  }

  it('prunes only old terminal releases while protecting newest, observed, and non-terminal rows per environment', async () => {
    addEnvironment('env-a', 1);
    for (const [version, status] of [
      [1, 'applied'],
      [2, 'applied'],
      [3, 'failed'],
      [4, 'applied'],
      [5, 'applied'],
      [6, 'applied'],
    ] as const) {
      addRelease('env-a', version, status);
    }

    // Fewer than N releases: nothing in this environment can be eligible.
    addEnvironment('env-b');
    addRelease('env-b', 1, 'applied');
    addRelease('env-b', 2, 'failed');

    // Old non-terminal and unknown future statuses fail closed even outside newest N.
    addEnvironment('env-c');
    for (const [version, status] of [
      [1, 'applying'],
      [2, 'created'],
      [3, 'queued-future-status'],
      [4, 'applied'],
      [5, 'applied'],
      [6, 'applied'],
    ] as const) {
      addRelease('env-c', version, status);
    }

    env.DEPLOYMENT_RELEASE_RETENTION_COUNT = '3';
    env.DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = '50';
    const result = await runDeploymentReleaseRetention(env);

    expect(result.deletedReleases).toBe(2);
    expect(releaseIds('env-a')).toEqual(['env-a-v1', 'env-a-v4', 'env-a-v5', 'env-a-v6']);
    expect(releaseIds('env-b')).toEqual(['env-b-v1', 'env-b-v2']);
    expect(releaseIds('env-c')).toEqual([
      'env-c-v1',
      'env-c-v2',
      'env-c-v3',
      'env-c-v4',
      'env-c-v5',
      'env-c-v6',
    ]);
  });

  it('respects the release deletion batch bound', async () => {
    addEnvironment('env-bounded');
    for (let version = 1; version <= 7; version += 1) {
      addRelease('env-bounded', version, 'applied');
    }
    env.DEPLOYMENT_RELEASE_RETENTION_COUNT = '2';
    env.DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = '2';

    const result = await runDeploymentReleaseRetention(env);

    expect(result.deletedReleases).toBe(2);
    expect(releaseIds('env-bounded')).toEqual([
      'env-bounded-v3',
      'env-bounded-v4',
      'env-bounded-v5',
      'env-bounded-v6',
      'env-bounded-v7',
    ]);
  });

  it('does not resurrect pruned release candidates on a second sweep', async () => {
    addEnvironment('env-zombie');
    for (let version = 1; version <= 5; version += 1) {
      addRelease('env-zombie', version, 'applied');
    }
    env.DEPLOYMENT_RELEASE_RETENTION_COUNT = '2';
    env.DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = '20';

    const first = await runDeploymentReleaseRetention(env);
    const survivors = releaseIds('env-zombie');
    const second = await runDeploymentReleaseRetention(env);

    expect(first.deletedReleases).toBe(3);
    expect(survivors).toEqual(['env-zombie-v4', 'env-zombie-v5']);
    expect(second.deletedReleases).toBe(0);
    expect(releaseIds('env-zombie')).toEqual(survivors);
  });

  it('interval-gates scheduled release retention with its own KV marker', async () => {
    addEnvironment('env-scheduled');
    for (let version = 1; version <= 4; version += 1) {
      addRelease('env-scheduled', version, 'applied');
    }
    env.DEPLOYMENT_RELEASE_RETENTION_COUNT = '2';
    await env.KV.put(
      DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY,
      '2026-08-09T00:00:00.000Z'
    );

    const skipped = await runScheduledDeploymentReleaseRetention(
      env,
      new Date('2026-08-09T01:00:00.000Z')
    );
    const ran = await runScheduledDeploymentReleaseRetention(
      env,
      new Date('2026-08-10T01:00:00.000Z')
    );

    expect(skipped).toMatchObject({ skipped: true, skipReason: 'interval-not-elapsed' });
    expect(ran.deletedReleases).toBe(2);
  });

  it('uses an independent KV marker for scheduled snapshot purging', async () => {
    addEnvironment('env-marker');
    for (let version = 1; version <= 4; version += 1) {
      addRelease('env-marker', version, 'applied');
    }
    addSnapshot('expired-marker', '2026-08-01T00:00:00.000Z');
    await env.KV.put(
      DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY,
      '2026-08-09T00:00:00.000Z'
    );
    const now = new Date('2026-08-09T01:00:00.000Z');

    const releaseResult = await runScheduledDeploymentReleaseRetention(env, now);
    const snapshotResult = await runScheduledSessionSnapshotPurge(env, now);

    expect(releaseResult).toMatchObject({ skipped: true, skipReason: 'interval-not-elapsed' });
    expect(snapshotResult.deletedSnapshots).toBe(1);
    expect(snapshotResult.skipped).toBe(false);
    expect(await env.KV.get(DEFAULT_SESSION_SNAPSHOT_PURGE_LAST_RUN_KV_KEY)).toBe(
      now.toISOString()
    );
    expect(await env.KV.get(DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY)).toBe(
      '2026-08-09T00:00:00.000Z'
    );
  });

  it('purges only snapshots whose ISO expiry is strictly before now', async () => {
    addSnapshot('expired', '2026-08-09T09:59:59.999Z');
    addSnapshot('exact-boundary', '2026-08-09T10:00:00.000Z');
    addSnapshot('unexpired', '2026-08-09T10:00:00.001Z');

    const result = await runSessionSnapshotPurge(env, new Date('2026-08-09T10:00:00.000Z'));

    expect(result.deletedSnapshots).toBe(1);
    expect(snapshotIds()).toEqual(['exact-boundary', 'unexpired']);
  });

  it('respects the snapshot purge batch bound', async () => {
    addSnapshot('expired-a', '2026-08-01T00:00:00.000Z');
    addSnapshot('expired-b', '2026-08-02T00:00:00.000Z');
    addSnapshot('expired-c', '2026-08-03T00:00:00.000Z');
    addSnapshot('unexpired', '2026-08-11T00:00:00.000Z');
    env.SESSION_SNAPSHOT_PURGE_BATCH_SIZE = '2';

    const result = await runSessionSnapshotPurge(env, new Date('2026-08-10T00:00:00.000Z'));

    expect(result.deletedSnapshots).toBe(2);
    expect(snapshotIds()).toEqual(['expired-c', 'unexpired']);
  });

  it('leaves snapshot survivors stable on a second purge', async () => {
    addSnapshot('expired-a', '2026-08-01T00:00:00.000Z');
    addSnapshot('expired-b', '2026-08-02T00:00:00.000Z');
    addSnapshot('unexpired', '2026-08-11T00:00:00.000Z');
    const now = new Date('2026-08-10T00:00:00.000Z');

    const first = await runSessionSnapshotPurge(env, now);
    const survivors = snapshotIds();
    const second = await runSessionSnapshotPurge(env, now);

    expect(first.deletedSnapshots).toBe(2);
    expect(second.deletedSnapshots).toBe(0);
    expect(snapshotIds()).toEqual(survivors);
    expect(survivors).toEqual(['unexpired']);
  });
});
