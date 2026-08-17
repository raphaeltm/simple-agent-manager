import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  COMPOSE_IMAGE_ARTIFACT_PREFIX,
  runComposeImageArtifactCleanup,
} from '../../../src/scheduled/compose-image-artifact-cleanup';
import {
  DEFAULT_DEPLOYMENT_RELEASE_RETENTION_LAST_RUN_KV_KEY,
  runDeploymentReleaseRetention,
  runScheduledDeploymentReleaseRetention,
  runScheduledSessionSnapshotPurge,
  runSessionSnapshotPurge,
  runStaleDeploymentReleaseReconciliation,
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
      schema.deploymentReleaseEvents,
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

  function addEnvironment(
    id: string,
    observedAppliedSeq: number | null = null,
    options: { observedStatus?: string | null; observedAt?: string | null } = {}
  ): void {
    sqlite
      .prepare(
        `INSERT INTO deployment_environments
           (id, observed_applied_seq, observed_status, observed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, observedAppliedSeq, options.observedStatus ?? null, options.observedAt ?? null);
  }

  function artifactKey(name: string): string {
    return `${COMPOSE_IMAGE_ARTIFACT_PREFIX}project/env/workspace/upload/${name}.docker-save.tar`;
  }

  function composeArtifactManifest(name: string): string {
    return JSON.stringify({ services: [{ serviceName: name, r2Key: artifactKey(name) }] });
  }

  function addRelease(
    environmentId: string,
    version: number,
    status: string,
    options: {
      manifest?: string | null;
      createdAt?: string;
      statusUpdatedAt?: string | null;
      source?: string | null;
    } = {}
  ): void {
    sqlite
      .prepare(
        `INSERT INTO deployment_releases
           (id, environment_id, version, status, manifest, created_at, status_updated_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `${environmentId}-v${version}`,
        environmentId,
        version,
        status,
        options.manifest ?? null,
        options.createdAt ?? null,
        options.statusUpdatedAt ?? null,
        options.source ?? null
      );
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

  function releaseStatuses(environmentId: string): Record<string, string> {
    return Object.fromEntries(
      sqlite
        .prepare(
          `SELECT id, status FROM deployment_releases
           WHERE environment_id = ?
           ORDER BY version ASC`
        )
        .all(environmentId)
        .map((row) => {
          const typed = row as { id: string; status: string };
          return [typed.id, typed.status];
        })
    );
  }

  function addReleaseEvent(
    environmentId: string,
    version: number,
    createdAt: string,
    releaseId: string | null = `${environmentId}-v${version}`
  ): void {
    sqlite
      .prepare(
        `INSERT INTO deployment_release_events
           (id, project_id, environment_id, release_id, release_version, node_id, seq, event_type, message, created_at)
         VALUES (?, 'project-1', ?, ?, ?, 'node-1', 1, 'deployment.apply.fetch_started', 'fetching', ?)`
      )
      .run(
        `${environmentId}-v${version}-event-${createdAt}`,
        environmentId,
        releaseId,
        version,
        createdAt
      );
  }

  function makeR2(objects: Array<{ key: string; size: number; uploaded: Date }>) {
    const deleted: string[] = [];
    return {
      list: async () => ({ objects, truncated: false }),
      delete: async (key: string) => {
        deleted.push(key);
      },
      deleted,
    };
  }

  function addSnapshot(id: string, expiresAt: string, sleeping = true): void {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, expires_at, status, degradation, sleeping_at, sleep_status)
         VALUES (?, ?, 'available', 'none', ?, ?)`
      )
      .run(
        id,
        expiresAt,
        sleeping ? '2026-08-01T00:00:00.000Z' : null,
        sleeping ? 'sleeping' : null
      );
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

  it('protects fresh and actively observed applying compose releases', async () => {
    addEnvironment('env-fresh', 1, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-fresh', 1, 'applied', {
      createdAt: '2026-08-01T00:00:00.000Z',
      manifest: composeArtifactManifest('fresh-current'),
    });
    addRelease('env-fresh', 2, 'applying', {
      createdAt: '2026-08-16T11:30:00.000Z',
      statusUpdatedAt: '2026-08-16T11:30:00.000Z',
      manifest: composeArtifactManifest('fresh-applying'),
      source: 'compose-publish',
    });
    addRelease('env-fresh', 3, 'created', {
      createdAt: '2026-08-16T11:45:00.000Z',
      statusUpdatedAt: '2026-08-16T11:45:00.000Z',
      manifest: composeArtifactManifest('fresh-created'),
      source: 'compose-publish',
    });

    addEnvironment('env-active', 4, {
      observedStatus: 'applying',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-active', 5, 'applying', {
      createdAt: '2026-06-01T00:00:00.000Z',
      statusUpdatedAt: '2026-06-01T00:00:00.000Z',
      manifest: composeArtifactManifest('actively-applying'),
      source: 'compose-publish',
    });

    const result = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(result.reconciledReleases).toBe(0);
    expect(releaseStatuses('env-fresh')['env-fresh-v2']).toBe('applying');
    expect(releaseStatuses('env-fresh')['env-fresh-v3']).toBe('created');
    expect(releaseStatuses('env-active')['env-active-v5']).toBe('applying');
  });

  it('marks provably stale nonterminal compose releases failed', async () => {
    addEnvironment('env-stale', 3, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-stale', 4, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('stale-archive'),
      source: 'compose-publish',
    });
    addRelease('env-stale', 5, 'created', {
      createdAt: '2026-06-27T00:00:00.000Z',
      statusUpdatedAt: '2026-06-27T00:00:00.000Z',
      manifest: composeArtifactManifest('stale-created-archive'),
      source: 'compose-publish',
    });

    const result = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(result).toMatchObject({
      enabled: true,
      batchSize: 50,
      staleHours: 168,
      activityGraceHours: 6,
      reconciledReleases: 2,
    });
    expect(releaseStatuses('env-stale')).toEqual({
      'env-stale-v4': 'failed',
      'env-stale-v5': 'failed',
    });
  });

  it('protects the observed-applied release even when its row is nonterminal and old', async () => {
    addEnvironment('env-observed', 4, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-observed', 4, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('observed-applied'),
      source: 'compose-publish',
    });

    const result = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(result.reconciledReleases).toBe(0);
    expect(releaseStatuses('env-observed')).toEqual({ 'env-observed-v4': 'applying' });
  });

  it('runs stale reconciliation before terminal retention so R2 cleanup can reclaim unreferenced archives', async () => {
    const staleKey = artifactKey('stale-old');
    addEnvironment('env-order', 4, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-order', 1, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('stale-old'),
      source: 'compose-publish',
    });
    for (let version = 2; version <= 4; version += 1) {
      addRelease('env-order', version, 'applied', {
        createdAt: `2026-08-0${version}T00:00:00.000Z`,
        manifest: composeArtifactManifest(`applied-${version}`),
      });
    }
    env.DEPLOYMENT_RELEASE_RETENTION_COUNT = '3';
    env.DEPLOYMENT_RELEASE_RETENTION_BATCH_SIZE = '10';
    env.R2 = makeR2([
      { key: staleKey, size: 123, uploaded: new Date('2026-06-27T00:00:00.000Z') },
    ]) as unknown as R2Bucket;

    const retention = await runDeploymentReleaseRetention(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );
    const cleanup = await runComposeImageArtifactCleanup(env, new Date('2026-08-16T12:00:00.000Z'));

    expect(retention).toMatchObject({
      reconciledStaleReleases: 1,
      deletedReleases: 1,
    });
    expect(releaseIds('env-order')).toEqual(['env-order-v2', 'env-order-v3', 'env-order-v4']);
    expect((env.R2 as unknown as { deleted: string[] }).deleted).toEqual([staleKey]);
    expect(cleanup.deletedObjects).toBe(1);
  });

  it('bounds reconciliation batches and is idempotent across repeated sweeps', async () => {
    addEnvironment('env-batch', 0, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    for (let version = 1; version <= 3; version += 1) {
      addRelease('env-batch', version, 'applying', {
        createdAt: '2026-06-26T00:00:00.000Z',
        statusUpdatedAt: '2026-06-26T00:00:00.000Z',
        manifest: composeArtifactManifest(`batch-${version}`),
        source: 'compose-publish',
      });
    }
    env.DEPLOYMENT_RELEASE_RECONCILIATION_BATCH_SIZE = '2';

    const now = new Date('2026-08-16T12:00:00.000Z');
    const first = await runStaleDeploymentReleaseReconciliation(env, now);
    const second = await runStaleDeploymentReleaseReconciliation(env, now);
    const third = await runStaleDeploymentReleaseReconciliation(env, now);

    expect(first.reconciledReleases).toBe(2);
    expect(second.reconciledReleases).toBe(1);
    expect(third.reconciledReleases).toBe(0);
    expect(releaseStatuses('env-batch')).toEqual({
      'env-batch-v1': 'failed',
      'env-batch-v2': 'failed',
      'env-batch-v3': 'failed',
    });
  });

  it('protects stale-looking releases with recent apply activity events', async () => {
    addEnvironment('env-lease', 0, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-lease', 1, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('recent-event'),
      source: 'compose-publish',
    });
    addReleaseEvent('env-lease', 1, '2026-08-16T09:00:00.000Z');

    const result = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(result.reconciledReleases).toBe(0);
    expect(releaseStatuses('env-lease')).toEqual({ 'env-lease-v1': 'applying' });
  });

  it('honors reconciliation kill switch and stale-age configuration', async () => {
    addEnvironment('env-config', 0, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-config', 1, 'applying', {
      createdAt: '2026-08-10T00:00:00.000Z',
      statusUpdatedAt: '2026-08-10T00:00:00.000Z',
      manifest: composeArtifactManifest('configured-age'),
      source: 'compose-publish',
    });
    env.DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS = '240';

    const configuredProtected = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );
    env.DEPLOYMENT_RELEASE_RECONCILIATION_STALE_HOURS = '24';
    env.DEPLOYMENT_RELEASE_RECONCILIATION_ENABLED = 'false';
    const disabled = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(configuredProtected).toMatchObject({ staleHours: 240, reconciledReleases: 0 });
    expect(disabled).toMatchObject({ enabled: false, reconciledReleases: 0 });
    expect(releaseStatuses('env-config')).toEqual({ 'env-config-v1': 'applying' });
  });

  it('fails closed for malformed manifests, future status activity, future observations, and unknown statuses', async () => {
    addEnvironment('env-ambiguous', 0, {
      observedStatus: 'applied',
      observedAt: '2026-08-16T12:00:00.000Z',
    });
    addRelease('env-ambiguous', 1, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: `{"services":[{"r2Key":"${artifactKey('malformed')}"}`,
      source: 'compose-publish',
    });
    addRelease('env-ambiguous', 2, 'queued-future-status', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('future-status'),
      source: 'compose-publish',
    });
    addRelease('env-ambiguous', 3, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-08-17T00:00:00.000Z',
      manifest: composeArtifactManifest('future-status-update'),
      source: 'compose-publish',
    });
    addRelease('env-ambiguous', 4, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('build-on-node-same-prefix'),
      source: 'build-on-node',
    });
    addEnvironment('env-future-observed', 0, {
      observedStatus: 'applied',
      observedAt: '2026-08-17T00:00:00.000Z',
    });
    addRelease('env-future-observed', 1, 'applying', {
      createdAt: '2026-06-26T00:00:00.000Z',
      statusUpdatedAt: '2026-06-26T00:00:00.000Z',
      manifest: composeArtifactManifest('future-observed'),
      source: 'compose-publish',
    });

    const result = await runStaleDeploymentReleaseReconciliation(
      env,
      new Date('2026-08-16T12:00:00.000Z')
    );

    expect(result.reconciledReleases).toBe(0);
    expect(releaseStatuses('env-ambiguous')).toEqual({
      'env-ambiguous-v1': 'applying',
      'env-ambiguous-v2': 'queued-future-status',
      'env-ambiguous-v3': 'applying',
      'env-ambiguous-v4': 'applying',
    });
    expect(releaseStatuses('env-future-observed')).toEqual({
      'env-future-observed-v1': 'applying',
    });
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

  it('runs bounded snapshot expiry on every scheduled tick', async () => {
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

  it('never terminal-purges an active checkpoint even after its artifact expiry', async () => {
    addSnapshot('active-expired', '2026-08-01T00:00:00.000Z', false);
    addSnapshot('sleeping-expired', '2026-08-01T00:00:00.000Z');

    const result = await runSessionSnapshotPurge(env, new Date('2026-08-10T00:00:00.000Z'));

    expect(result.deletedSnapshots).toBe(1);
    expect(snapshotIds()).toEqual(['active-expired']);
  });

  it('lets an in-flight wake win over terminal purge', async () => {
    addSnapshot('waking-expired', '2026-08-01T00:00:00.000Z');
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET recovery_status = 'waking', recovery_task_id = 'wake-task'
         WHERE id = 'waking-expired'`
      )
      .run();

    const result = await runSessionSnapshotPurge(env, new Date('2026-08-10T00:00:00.000Z'));

    expect(result.deletedSnapshots).toBe(0);
    expect(snapshotIds()).toEqual(['waking-expired']);
  });

  it('reclaims an interrupted terminal purge after its claim lease', async () => {
    addSnapshot('stale-purge', '2026-08-01T00:00:00.000Z');
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET status = 'expired', sleep_status = 'purging',
             sleep_claim_id = 'dead-purger', sleep_claimed_at = '2026-08-09T23:00:00.000Z'
         WHERE id = 'stale-purge'`
      )
      .run();

    const result = await runSessionSnapshotPurge(env, new Date('2026-08-10T00:00:00.000Z'));

    expect(result.deletedSnapshots).toBe(1);
    expect(snapshotIds()).toEqual([]);
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
