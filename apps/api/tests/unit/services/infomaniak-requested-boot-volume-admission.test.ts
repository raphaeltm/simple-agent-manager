/**
 * #2842: Infomaniak boots from a volume of any requested size, and a direct node may run on a
 * shared platform credential, so a user-supplied `bootDiskSizeGb` is capped at the admin setting
 * `infomaniak.bootVolumeGb` where the request is admitted (`resolveCanonicalVmAllocationPlan`), not
 * in `createVM`, so sizes already stored on node rows keep provisioning after the setting is lowered.
 *
 * Runs the real allocation entry point and the real settings writer on SQLite.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { updateAdminSettings } from '../../../src/services/admin-settings';
import { resolveCanonicalVmAllocationPlan } from '../../../src/services/canonical-vm-allocation';
import { generateEncryptionKey } from '../../../src/services/encryption';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

const USER_ID = 'user-1';
let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

function setup(provider: 'infomaniak' | 'hetzner') {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  seedUser(sqlite, USER_ID);
  seedCloudCredential(sqlite, { id: `cloud-${provider}`, userId: USER_ID, provider });
  const database = createSqliteD1(sqlite);
  const env = {
    DATABASE: database,
    KV: createMemoryKv(),
    ENCRYPTION_KEY: generateEncryptionKey(),
  } as unknown as Env;
  const allocate = (
    bootDiskSizeGb: number | null,
    entryPoint: 'direct-node' | 'direct-workspace' | 'session-snapshot-relay' = 'direct-node'
  ) =>
    resolveCanonicalVmAllocationPlan(drizzle(database, { schema }) as never, env, {
      entryPoint,
      taskId: 'task-boot-disk',
      userId: USER_ID,
      projectId: null,
      explicit: {
        vmSize: 'medium',
        provider,
        vmLocation: provider === 'infomaniak' ? 'dc4-a' : 'fsn1',
        native: {
          providerInstanceType: provider === 'infomaniak' ? 'a4-ram8-disk20-perf1' : 'cx33',
          providerInstanceBootDiskSizeGb: bootDiskSizeGb,
        },
      },
      credentialProjectPolicy: 'inherited-or-none',
      taskModeDefault: 'task',
      workloadRole: 'workspace',
      capacityPoolEnsure: false,
    });
  const setBootVolumeGb = (value: number) =>
    updateAdminSettings(env, {
      changes: [{ name: 'infomaniak.bootVolumeGb', value }],
      actorUserId: 'admin',
    });
  return { allocate, setBootVolumeGb };
}

describe('requested Infomaniak boot volume admission', () => {
  it('refuses a request above the configured size before anything is allocated', async () => {
    const { allocate } = setup('infomaniak');
    const plan = await allocate(4_096);
    expect(plan).toMatchObject({ errorKind: 'placement' });
    expect('error' in plan && plan.error).toContain('infomaniak.bootVolumeGb');
  });

  it.each([60, 80])('admits a request of %s GB (configured 80)', async (size) => {
    const { allocate } = setup('infomaniak');
    const plan = await allocate(size);
    expect(plan).not.toHaveProperty('error');
    expect(plan).toMatchObject({
      effectiveProvider: 'infomaniak',
      providerInstanceBootDiskSizeGb: size,
    });
  });

  it('admits a request without a boot size', async () => {
    const { allocate } = setup('infomaniak');
    const plan = await allocate(null);
    expect(plan).toMatchObject({ effectiveProvider: 'infomaniak' });
  });

  it('follows an admin change of the setting', async () => {
    const { allocate, setBootVolumeGb } = setup('infomaniak');
    await setBootVolumeGb(150);
    expect(await allocate(120)).toMatchObject({ providerInstanceBootDiskSizeGb: 120 });
    const refused = await allocate(200);
    expect('error' in refused && refused.error).toContain('150GB');
  });

  it('applies to workspace create requests too', async () => {
    const { allocate } = setup('infomaniak');
    const refused = await allocate(4_096, 'direct-workspace');
    expect('error' in refused && refused.error).toContain('infomaniak.bootVolumeGb');
  });

  it('does not cap a size replayed from an existing node after the setting is lowered', async () => {
    // The session-snapshot relay copies a source node's stored size. A node recorded at 200 GB
    // when the setting allowed it must keep resolving after an admin lowers the setting.
    const { allocate, setBootVolumeGb } = setup('infomaniak');
    await setBootVolumeGb(40);
    expect(await allocate(200, 'session-snapshot-relay')).toMatchObject({
      effectiveProvider: 'infomaniak',
      providerInstanceBootDiskSizeGb: 200,
    });
    // Control: the same size as a new request is refused.
    const refused = await allocate(200, 'direct-node');
    expect('error' in refused && refused.error).toContain('40GB');
  });

  it('does not apply the Infomaniak cap to other providers', async () => {
    const { allocate } = setup('hetzner');
    // Admission leaves other providers' explicit sizes to their own createVM checks.
    expect(await allocate(4_096)).toMatchObject({
      effectiveProvider: 'hetzner',
      providerInstanceBootDiskSizeGb: 4_096,
    });
  });
});
