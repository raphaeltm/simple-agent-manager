/**
 * Compute pool editor redesign (tasks/active/2026-11-09-compute-pool-editor-redesign.md):
 *
 * - nothing joins a pool on its own: a new account, machine type or region starts unselected,
 *   except a new zone of a region the person already picked;
 * - a person can switch an account off (picks kept, never placed) and back on, and adding a
 *   machine from a switched-off account switches it on;
 * - editor reads name each account; a VM task against an empty pool gets a plain message.
 *
 * Everything runs against a real SQLite engine through the D1 adapter (rule 28).
 */
import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { attachCapacitySourceLabels } from '../../../src/services/default-capacity-pool-source-labels';
import {
  publishSourceSettingsOnly,
  resolveSourceSettingsUpdate,
} from '../../../src/services/default-capacity-pool-source-settings';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import {
  ensureDefaultCapacityPoolsForExistingCredentials,
  readDefaultCapacityPoolSummaries,
} from '../../../src/services/default-capacity-pools';
import { noEligibleCapacityCandidateMessage } from '../../../src/services/placement-resolution-error';
import { resolveTaskStartPlacement } from '../../../src/services/placement-resolver';
import { buildCapacityPoolSelection } from '../../../src/services/placement-resolver-capacity';
import { offering } from '../../helpers/capacity-pool-offerings';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

function db() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  const database = createSqliteD1WithBindLimit(sqlite, 100);
  return { d1: drizzle(database, { schema }), env: { DATABASE: database } as unknown as Env };
}

async function refresh(d1: ReturnType<typeof db>['d1'], offerings: ProviderInstanceOffering[]) {
  return ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    userId: 'user-1',
    includeInstallation: false,
    candidatePublishBatchSize: 1000,
    offeringResolver: async () => offerings,
  });
}

function statuses(): Record<string, string> {
  const rows = sqlite!
    .prepare(
      `SELECT location, provider_instance_type AS type, status FROM capacity_pool_candidates
       WHERE workload_role = 'workspace' ORDER BY location, type`
    )
    .all() as Array<{ location: string; type: string; status: string }>;
  return Object.fromEntries(rows.map((row) => [`${row.location}/${row.type}`, row.status]));
}

async function pick(d1: ReturnType<typeof db>['d1'], keys: string[]) {
  const rows = sqlite!
    .prepare(
      `SELECT id, location, provider_instance_type AS type FROM capacity_pool_candidates
       WHERE workload_role = 'workspace'`
    )
    .all() as Array<{ id: string; location: string; type: string }>;
  const ids = rows.filter((row) => keys.includes(`${row.location}/${row.type}`)).map((r) => r.id);
  expect(ids).toHaveLength(keys.length);
  const result = await updateDefaultCapacityPool(d1 as never, {
    scope: 'user',
    ownerUserId: 'user-1',
    ownerProjectId: null,
    candidates: ids.map((id) => ({ id, status: 'active' as const })),
  });
  expect(result.conflict).toBe(false);
  return result;
}

describe('nothing joins a pool on its own', () => {
  it('starts a newly connected account with every machine listed and none picked', async () => {
    const { d1 } = db();
    seedCloudCredential(sqlite!, { id: 'gcp-1', userId: 'user-1', provider: 'gcp' });
    // e2-standard-4 maps to the old `medium` size, which used to switch it on by itself.
    const result = await refresh(d1, [
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'us-central1-a', 'e2-standard-4', { machineSize: 'medium' }),
    ]);
    expect(result.user?.candidates).toHaveLength(2);
    expect(result.user?.activeCandidateCount).toBe(0);
    expect(result.user?.effectiveState).toBe('configured-empty');
  });

  it('adds new zones of a picked region, and nothing in regions or machines nobody picked', async () => {
    const { d1 } = db();
    seedCloudCredential(sqlite!, { id: 'gcp-1', userId: 'user-1', provider: 'gcp' });
    await refresh(d1, [
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'us-central1-a', 'e2-standard-4', { machineSize: 'medium' }),
    ]);
    await pick(d1, ['europe-west1-b/e2-standard-4']);

    // The catalog grows: a new zone in the picked region, a new zone in an unpicked region, a
    // new region, and a new machine type in the picked region.
    await refresh(d1, [
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'europe-west1-c', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'us-central1-a', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'us-central1-b', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'asia-northeast1-a', 'e2-standard-4', { machineSize: 'medium' }),
      offering('gcp', 'europe-west1-b', 'e2-standard-8', { machineSize: 'large' }),
    ]);

    expect(statuses()).toEqual({
      'asia-northeast1-a/e2-standard-4': 'disabled',
      'europe-west1-b/e2-standard-4': 'active',
      // Picking a region means any of its zones, including ones the provider adds later.
      'europe-west1-c/e2-standard-4': 'active',
      'europe-west1-b/e2-standard-8': 'disabled',
      'us-central1-a/e2-standard-4': 'disabled',
      'us-central1-b/e2-standard-4': 'disabled',
    });
  });

  it('does not add a new zone to a region whose machines the person removed', async () => {
    const { d1 } = db();
    seedCloudCredential(sqlite!, { id: 'gcp-1', userId: 'user-1', provider: 'gcp' });
    await refresh(d1, [offering('gcp', 'europe-west1-b', 'e2-standard-4')]);
    const picked = await pick(d1, ['europe-west1-b/e2-standard-4']);
    const id = picked.summary!.candidates.find((c) => c.location === 'europe-west1-b')!.id;
    await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id, status: 'deleted' }],
    });
    await refresh(d1, [
      offering('gcp', 'europe-west1-b', 'e2-standard-4'),
      offering('gcp', 'europe-west1-d', 'e2-standard-4'),
    ]);
    expect(statuses()).toEqual({
      'europe-west1-b/e2-standard-4': 'deleted',
      'europe-west1-d/e2-standard-4': 'disabled',
    });
  });
});

describe('accounts switched on and off', () => {
  async function twoAccountPool() {
    const fixture = db();
    seedCloudCredential(sqlite!, { id: 'hz-1', userId: 'user-1', provider: 'hetzner' });
    seedCloudCredential(sqlite!, { id: 'hz-2', userId: 'user-1', provider: 'hetzner' });
    await refresh(fixture.d1, [
      offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR', price: '€7.49/mo' }),
    ]);
    const rows = sqlite!
      .prepare(
        `SELECT id, capacity_source_id AS sourceId FROM capacity_pool_candidates
         WHERE workload_role = 'workspace' ORDER BY capacity_source_id`
      )
      .all() as Array<{ id: string; sourceId: string }>;
    expect(rows).toHaveLength(2);
    await updateDefaultCapacityPool(fixture.d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: rows.map(({ id }) => ({ id, status: 'active' as const })),
    });
    return { ...fixture, sourceId: rows[0]!.sourceId, otherSourceId: rows[1]!.sourceId };
  }

  function placement() {
    return resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      project: { id: 'project-1', defaultProvider: null, defaultVmSize: 'small' },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
  }

  it('keeps the picks of a switched-off account but never places on it', async () => {
    const { d1, sourceId, otherSourceId } = await twoAccountPool();
    const on = await readDefaultCapacityPoolSummaries(d1 as never, {
      userId: 'user-1',
      includeInstallation: false,
      includeDisabled: true,
    });
    // Control: with both accounts on, placement can use either.
    expect(
      buildCapacityPoolSelection(on.user!, placement(), 'workspace')
        ?.candidates.map((c) => c.capacitySourceId)
        .sort()
    ).toEqual([sourceId, otherSourceId].sort());

    const off = await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      excludedSourceIds: [sourceId],
    });
    // The switched-off account keeps its pick; the pool stays ready on the other account.
    expect(
      off.summary?.candidates.filter((c) => c.status === 'active').map((c) => c.capacitySourceId)
    ).toHaveLength(2);
    const partial = buildCapacityPoolSelection(off.summary!, placement(), 'workspace');
    expect(partial?.effectiveState).toBe('configured-ready');
    expect(partial?.candidates.map((c) => c.capacitySourceId)).toEqual([otherSourceId]);

    const allOff = await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      excludedSourceIds: [sourceId, otherSourceId],
    });
    const selection = buildCapacityPoolSelection(allOff.summary!, placement(), 'workspace');
    expect(selection?.effectiveState).toBe('configured-empty');
    expect(selection?.candidates).toHaveLength(0);
    // The refusal says the pool has no machines, in plain words.
    expect(noEligibleCapacityCandidateMessage(placement(), selection!)).toBe(
      'Your compute pool has no machines, so work that needs a VM cannot start. Add machines to it in its infrastructure settings, or run this as an Instant session.'
    );
  });

  it('switches an account back on when a machine from it is added', async () => {
    const { d1, sourceId } = await twoAccountPool();
    await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      excludedSourceIds: [sourceId],
    });
    await refresh(d1, [
      offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR' }),
      offering('hetzner', 'nbg1', 'cx33', { currency: 'EUR' }),
    ]);
    const nbg = sqlite!
      .prepare(
        `SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace'
         AND location = 'nbg1' AND capacity_source_id = ?`
      )
      .get(sourceId) as { id: string };
    const added = await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id: nbg.id, status: 'active' }],
    });
    expect(added.summary?.pool.excludedSourceIds).toEqual([]);
    expect(added.summary?.activeCandidateCount).toBe(3);
  });

  it('refuses to switch off an id that is not an account of this pool', async () => {
    const { d1 } = await twoAccountPool();
    const result = await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      excludedSourceIds: ['someone-elses-source'],
    });
    expect(result.missingSourceIds).toEqual(['someone-elses-source']);
    expect(
      sqlite!.prepare('SELECT excluded_source_ids_json AS v FROM capacity_pools').get()
    ).toEqual({ v: null });
  });

  it('refuses an on/off edit made against a stale read (no lost update)', async () => {
    const { d1, sourceId } = await twoAccountPool();
    const [stalePool] = await d1.select().from(schema.capacityPools);
    // Another editor switches the account off after this edit read the pool.
    await updateDefaultCapacityPool(d1 as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      excludedSourceIds: [sourceId],
    });
    const stale = await resolveSourceSettingsUpdate(
      d1 as never,
      stalePool!,
      { scope: 'user', ownerUserId: 'user-1', ownerProjectId: null, excludedSourceIds: [sourceId] },
      []
    );
    expect(stale.changed).toBe(true);
    // The write is fenced on the value it read, so it is a conflict, not a silent overwrite.
    expect(await publishSourceSettingsOnly(d1 as never, stalePool!, stale)).toBe(false);
  });
});

describe('account names in editor reads', () => {
  it('names a connection and a platform credential, and leaves a plain key unnamed', async () => {
    const { d1 } = db();
    sqlite!.exec(`
      INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv)
        VALUES ('cc-1', 'user-1', '  SAM GCP Prod  ', 'cloud-provider', 'x', 'y');
      INSERT INTO platform_credentials (id, credential_type, provider, credential_kind, label,
        encrypted_token, iv, is_enabled, created_by)
        VALUES ('plat-1', 'cloud-provider', 'hetzner', 'api-key', 'Shared Hetzner', 'x', 'y', 1, 'user-1');
    `);
    const source = (id: string, extra: Record<string, unknown>) =>
      ({ id, credentialReference: null, platformCredentialId: null, ...extra }) as never;
    const summary = {
      sources: [
        source('a', { credentialReference: 'cc_credentials:cc-1' }),
        source('b', { platformCredentialId: 'plat-1' }),
        source('c', { credentialReference: 'credentials:legacy-key' }),
      ],
    } as never;
    await attachCapacitySourceLabels(d1 as never, [summary, null]);
    expect(
      (summary as { sources: Array<{ label: string | null }> }).sources.map((s) => s.label)
    ).toEqual(['SAM GCP Prod', 'Shared Hetzner', null]);
  });
});
