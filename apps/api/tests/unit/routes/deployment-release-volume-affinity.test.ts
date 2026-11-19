import type { DeploymentManifest } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createDeploymentReleaseFromManifest } from '../../../src/routes/deployment-release-submission';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const resolvePlacement = vi.hoisted(() => vi.fn());
const createVolumes = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../../src/services/deployment-provisioning', async (load) => ({
  ...(await load<typeof import('../../../src/services/deployment-provisioning')>()),
  resolveDeploymentPlacement: resolvePlacement,
}));
vi.mock('../../../src/services/deployment-volumes', async (load) => ({
  ...(await load<typeof import('../../../src/services/deployment-volumes')>()),
  createMissingManifestVolumes: createVolumes,
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));
const databases: Database.Database[] = [];
function fixture() {
  resolvePlacement.mockReset();
  createVolumes.mockClear();
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createAllSchemaTables(sqlite, schema);
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const db = drizzle(env.DATABASE, { schema });
  sqlite.exec(`INSERT INTO deployment_environments (id, project_id, node_id, status)
    VALUES ('environment', 'project', NULL, 'stopped');
    INSERT INTO deployment_volumes (id, environment_id, name, provider_name, location, size_gb, provider_volume_id, status)
    VALUES ('volume', 'environment', 'data', 'hetzner', 'nbg1', 10, 'provider-volume', 'available');`);
  const manifest: DeploymentManifest = {
    version: 1,
    services: {
      web: {
        image: { registry: 'docker.io', repository: 'test', digest: `sha256:${'a'.repeat(64)}` },
        env: {},
        volumes: [{ name: 'data', mountPath: '/data' }],
      },
    },
    volumes: { data: {}, logs: {} },
    routes: [],
  };
  const submit = () =>
    createDeploymentReleaseFromManifest(db, manifest, {
      envId: 'environment',
      projectId: 'project',
      userId: 'user',
      env,
    });
  return { sqlite, submit, env, manifest };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe('release submission volume affinity', () => {
  it('pins placement and newly declared volumes to existing volume provider/location', async () => {
    const f = fixture();
    resolvePlacement.mockImplementation(async (_user, _env, _project, options) => ({
      provider: options.providerOverride ?? 'gcp',
      location: options.vmLocationOverride ?? 'us-central1-a',
      vmSize: 'small',
    }));
    expect((await f.submit()).success).toBe(true);
    expect(resolvePlacement).toHaveBeenCalledWith(
      'user',
      f.env,
      'project',
      expect.objectContaining({
        providerOverride: 'hetzner',
        vmLocationOverride: 'nbg1',
      })
    );
    expect(createVolumes).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user',
      expect.objectContaining({
        targetProvider: 'hetzner',
        location: 'nbg1',
        manifest: expect.objectContaining({ volumes: { data: {}, logs: {} } }),
      })
    );
  });
  it('pins stored volumes even when the new manifest omits volumes', async () => {
    const f = fixture();
    f.manifest.volumes = {};
    f.manifest.services.web!.volumes = [];
    resolvePlacement.mockResolvedValue({ provider: 'hetzner', location: 'nbg1', vmSize: 'small' });
    expect((await f.submit()).success).toBe(true);
    expect(resolvePlacement).toHaveBeenCalledWith(
      'user',
      f.env,
      'project',
      expect.objectContaining({ providerOverride: 'hetzner', vmLocationOverride: 'nbg1' })
    );
    expect(createVolumes).not.toHaveBeenCalled();
  });
  it('reports unavailable pinned placement before creating volumes or a release', async () => {
    const f = fixture();
    resolvePlacement.mockResolvedValue(null);
    expect(await f.submit()).toMatchObject({
      success: false,
      response: { status: 400, body: { error: 'VOLUME_PLACEMENT_UNAVAILABLE' } },
    });
    expect(createVolumes).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM deployment_releases').get()).toEqual({
      count: 0,
    });
  });
  it.each([
    ['hetzner', 'fsn1'],
    ['scaleway', 'nbg1'],
  ])('rejects conflicting volume affinity (%s/%s)', async (provider, location) => {
    const f = fixture();
    f.sqlite
      .prepare(
        `INSERT INTO deployment_volumes (id, environment_id, name, provider_name, location, size_gb, provider_volume_id, status)
      VALUES ('other', 'environment', 'logs', ?, ?, 10, 'other-volume', 'available')`
      )
      .run(provider, location);
    await expect(f.submit()).rejects.toThrow('must all use the same provider and location');
    expect(resolvePlacement).not.toHaveBeenCalled();
    expect(createVolumes).not.toHaveBeenCalled();
  });
});
