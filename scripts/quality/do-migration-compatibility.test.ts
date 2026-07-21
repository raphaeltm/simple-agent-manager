import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateApiWorkerEnv,
  getDeployedWorkerMigrationTag,
  resolveDurableObjectMigrations,
} from '../deploy/sync-wrangler-config.js';
import type { MigrationEntry, PulumiOutputs, WranglerToml } from '../deploy/types.js';

const WRANGLER_TOML_PATH = resolve(import.meta.dirname, '../../apps/api/wrangler.toml');

const outputs: PulumiOutputs = {
  d1DatabaseId: 'd1-id',
  d1DatabaseName: 'prefix-prod',
  observabilityD1DatabaseId: 'obs-d1-id',
  observabilityD1DatabaseName: 'prefix-observability-prod',
  kvId: 'kv-id',
  kvName: 'prefix-prod-sessions',
  r2Name: 'prefix-prod-assets',
  sessionSnapshotTtlDays: 30,
  dnsIds: {
    api: 'api-dns-id',
    app: 'app-dns-id',
    wildcard: 'wildcard-dns-id',
  },
  hostnames: {
    api: 'api.example.com',
    app: 'app.example.com',
  },
  stackSummary: {
    stack: 'prod',
    baseDomain: 'example.com',
    resources: {
      d1: 'prefix-prod',
      kv: 'prefix-prod-sessions',
      r2: 'prefix-prod-assets',
    },
  },
  cloudflareAccountId: 'account-id',
  pagesName: 'prefix-web-prod',
};

function loadCheckedInMigrations(): MigrationEntry[] {
  const config = TOML.parse(readFileSync(WRANGLER_TOML_PATH, 'utf8')) as WranglerToml;
  return config.migrations as MigrationEntry[];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveDurableObjectMigrations', () => {
  it('generates an all-SQLite bootstrap from the complete checked-in history for a clean install', () => {
    const history = loadCheckedInMigrations();
    const legacyCreateCount = history.filter((migration) => migration.new_classes).length;

    const resolved = resolveDurableObjectMigrations(history, null);

    expect(history).toHaveLength(17);
    expect(legacyCreateCount).toBe(7);
    expect(resolved).toHaveLength(history.length);
    expect(resolved.every((migration) => migration.new_classes === undefined)).toBe(true);
    expect(resolved.flatMap((migration) => migration.new_sqlite_classes ?? [])).toHaveLength(17);
    expect(loadCheckedInMigrations()).toEqual(history);
  });

  it('preserves the complete migration history for an existing legacy deployment at v17', () => {
    const history = loadCheckedInMigrations();
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');

    const resolved = resolveDurableObjectMigrations(history, 'v17');
    const envConfig = generateApiWorkerEnv(
      { migrations: history },
      outputs,
      'prod',
      false,
      false,
      'v17'
    );

    expect(resolved).toEqual(history);
    resolved.forEach((migration, index) => expect(migration).toBe(history[index]));
    expect(envConfig.migrations).toEqual(history);
  });

  it('preserves an applied prefix and converts only pending legacy creates', () => {
    const history: MigrationEntry[] = [
      { tag: 'v1', new_sqlite_classes: ['SqliteFirst'] },
      { tag: 'v2', new_classes: ['AppliedLegacy'] },
      { tag: 'v3', new_classes: ['PendingLegacy'] },
      {
        tag: 'v4',
        renamed_classes: [{ from: 'PendingLegacy', to: 'RenamedPendingLegacy' }],
      },
      { tag: 'v5', deleted_classes: ['DeletedClass'] },
    ];

    const resolved = resolveDurableObjectMigrations(history, 'v2');

    expect(resolved).toEqual([
      history[0],
      history[1],
      { tag: 'v3', new_sqlite_classes: ['PendingLegacy'] },
      history[3],
      history[4],
    ]);
    expect(resolved[0]).toBe(history[0]);
    expect(resolved[1]).toBe(history[1]);
    expect(resolved[3]).toBe(history[3]);
    expect(resolved[4]).toBe(history[4]);
  });

  it('combines pending legacy and SQLite creates without mutating the source entry', () => {
    const history: MigrationEntry[] = [
      {
        tag: 'v1',
        new_classes: ['LegacyClass'],
        new_sqlite_classes: ['SqliteClass'],
      },
    ];

    expect(resolveDurableObjectMigrations(history, null)).toEqual([
      { tag: 'v1', new_sqlite_classes: ['SqliteClass', 'LegacyClass'] },
    ]);
    expect(history[0]).toEqual({
      tag: 'v1',
      new_classes: ['LegacyClass'],
      new_sqlite_classes: ['SqliteClass'],
    });
  });

  it('fails closed when the deployed tag is not in the checked-in history', () => {
    expect(() =>
      resolveDurableObjectMigrations([{ tag: 'v1', new_classes: ['LegacyClass'] }], 'v999')
    ).toThrow('Deployed Durable Object migration tag "v999" is not present');
  });

  it('fails closed when the checked-in history contains duplicate tags', () => {
    expect(() =>
      resolveDurableObjectMigrations(
        [{ tag: 'v1', new_classes: ['LegacyClass'] }, { tag: 'v1' }],
        null
      )
    ).toThrow('Durable Object migration tag "v1" is duplicated');
  });

  it('feeds the resolved clean-install history into the generated environment', () => {
    vi.stubEnv('RESOURCE_PREFIX', 's123abc');
    const topLevel = TOML.parse(readFileSync(WRANGLER_TOML_PATH, 'utf8')) as WranglerToml;

    const envConfig = generateApiWorkerEnv(topLevel, outputs, 'prod', false, false, null);
    const generatedConfig = TOML.parse(
      TOML.stringify({
        env: { production: envConfig },
      } as TOML.JsonMap)
    ) as WranglerToml;
    const generatedMigrations = generatedConfig.env?.production?.migrations;

    expect(generatedMigrations).toEqual(
      resolveDurableObjectMigrations(topLevel.migrations as MigrationEntry[], null)
    );
    expect(generatedMigrations?.every((migration) => !migration.new_classes)).toBe(true);
    expect(topLevel.migrations).toEqual(loadCheckedInMigrations());
  });
});

describe('getDeployedWorkerMigrationTag', () => {
  it('returns null only when the exact Worker lookup confirms a clean target', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"success":true,"result":[]}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts?per_page=1000',
      { headers: { Authorization: 'Bearer token' } }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/api-worker/settings',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('reads the migration tag from the Workers scripts list for an existing Worker', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"success":true,"result":[{"id":"api-worker","migration_tag":"v17"}]}', {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).resolves.toBe('v17');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts?per_page=1000',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('fails closed before exact lookup when the Workers listing is unreadable', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('sensitive-control-plane-detail', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).rejects.toThrow(
      /^Failed to list Workers while reading migration state for "api-worker" \(HTTP 403\)$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when exact Worker state cannot be read without leaking response content', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"success":true,"result":[]}', { status: 200 }))
        .mockResolvedValueOnce(new Response('sensitive-control-plane-detail', { status: 403 }))
    );

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).rejects.toThrow(
      /^Failed to read Durable Object migration state for Worker "api-worker" \(HTTP 403\)$/
    );
  });

  it('fails closed when an existing Worker is omitted from the scripts listing', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"success":true,"result":[]}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{"success":true,"result":{}}', { status: 200 }))
    );

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).rejects.toThrow(
      'exists but is absent from the Workers scripts listing'
    );
  });

  it('fails closed when an existing Worker has no migration tag', async () => {
    vi.stubEnv('CF_API_TOKEN', 'token');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"success":true,"result":[{"id":"api-worker"}]}', { status: 200 })
        )
    );

    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).rejects.toThrow(
      'has no migration_tag'
    );
  });

  it('requires the deployment token before probing migration state', async () => {
    await expect(getDeployedWorkerMigrationTag('account-id', 'api-worker')).rejects.toThrow(
      'CF_API_TOKEN or CLOUDFLARE_API_TOKEN is required'
    );
  });
});
