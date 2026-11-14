/**
 * GCP boot disk sizing across the catalog → pool candidate → plan → VM path, on a real SQLite
 * engine (the reuse guard is a SQL predicate, rule 28).
 *
 * Before this change every GCP offering advertised 50 GB and every VM got 50 GB. Now a
 * t2d-standard-8 advertises and gets 160 GB. Running nodes were created with 50 GB, and the
 * catalog refresh rewrites the candidate they point at, so the refresh must not push them outside
 * the current pool allocation authority (`buildPlacementAuthoritySqlPredicate`, owned by PR #2693
 * and not changed here). It holds because the refresh changes only `provider_instance_disk_gb` and
 * leaves `provider_instance_boot_disk_size_gb` NULL; the control test shows the node would be
 * refused if the size were written to the boot-disk column instead.
 */
import { GcpProvider } from '@simple-agent-manager/providers';
import {
  capacityPlacementSnapshotForCandidate,
  resolveReusableNodeCapacitySnapshot,
} from '@simple-agent-manager/scheduler-core';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { ensureCandidatesForSource } from '../../../src/services/default-capacity-pool-candidates-publication';
import type { TaskStartCapacityPoolSelection } from '../../../src/services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../../src/services/reusable-node-authority';
import {
  applyNativePlanToVmConfig,
  observedHardwareDbValues,
} from '../../../src/services/runtime-allocation';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const VERSION = 1_700_000_000_000;
const TS = new Date(VERSION).toISOString();
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const ZONE = 'europe-west1-b';
const POOL_ID = 'pool-user';
const SOURCE_ID = 'source-gcp';

let sqlite: Database.Database | null = null;
const originalFetch = globalThis.fetch;
afterEach(() => {
  sqlite?.close();
  sqlite = null;
  globalThis.fetch = originalFetch;
});

function setup() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO project_members (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES ('${PROJECT_ID}', '${USER_ID}', 'owner', 'active', NULL, '${TS}', '${TS}');
    INSERT INTO credentials (id, user_id, project_id, provider, credential_type, is_active,
      encrypted_token, iv, created_at, updated_at)
    VALUES ('gcp-cred', '${USER_ID}', NULL, 'gcp', 'cloud-provider', 1, 'enc', 'iv', '${TS}', '${TS}');
    INSERT INTO capacity_pools (id, scope, owner_user_id, owner_project_id, name, is_default,
      revision, status, configuration_state, strategy, exhaustion_policy, migration_state,
      created_at, updated_at)
    VALUES ('${POOL_ID}', 'user', '${USER_ID}', NULL, 'Mine', 1, 4, 'active', 'configured-ready',
      'pack', 'fallback-chain', 'complete', '${TS}', '${TS}');
    INSERT INTO capacity_sources (id, scope, owner_user_id, owner_project_id, source_kind, provider,
      credential_source, credential_id, platform_credential_id, credential_reference,
      credential_version, external_source_ref, status, source_generation, authority_generation,
      created_at, updated_at)
    VALUES ('${SOURCE_ID}', 'user', '${USER_ID}', NULL, 'cloud-provider-credential', 'gcp', 'user',
      'gcp-cred', NULL, 'credentials:gcp-cred', ${VERSION}, NULL, 'active', 1, ${VERSION},
      '${TS}', '${TS}');
  `);
  const database = createSqliteD1(sqlite);
  return { database, db: drizzle(database, { schema }) };
}

/** A GcpProvider reading a one-type live catalog through stubbed Compute endpoints. */
function gcpProvider(policy?: { gbPerVcpu: number; minGb: number }) {
  return new GcpProvider(
    'p',
    async () => 'token',
    ZONE,
    undefined,
    undefined,
    policy,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { machineTypes: ['t2d-standard-8'], priceTable: async () => null }
  );
}

function stubCompute(inserted: string[] = []) {
  globalThis.fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('/aggregated/machineTypes')) {
      return json({
        items: {
          [`zones/${ZONE}`]: {
            machineTypes: [{ name: 't2d-standard-8', zone: ZONE, guestCpus: 8, memoryMb: 32_768 }],
          },
        },
      });
    }
    if (url.endsWith('/global/firewalls') && init.method === 'POST') {
      return json({ error: { code: 409, message: 'exists' } }, 409);
    }
    if (url.endsWith('/instances') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        disks: Array<{ initializeParams: { diskSizeGb: string } }>;
      };
      inserted.push(body.disks[0]!.initializeParams.diskSizeGb);
      return json({ name: 'op-1', status: 'PENDING' });
    }
    if (url.includes('/operations/')) return json({ name: 'op-1', status: 'DONE' });
    if (url.includes('/instances/node-new')) {
      return json({
        id: '1',
        name: 'node-new',
        status: 'RUNNING',
        creationTimestamp: TS,
        machineType: `zones/${ZONE}/machineTypes/t2d-standard-8`,
        disks: [{ boot: true, diskSizeGb: inserted.at(-1) }],
        networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.10' }] }],
      });
    }
    if (url.includes('/machineTypes/t2d-standard-8'))
      return json({ guestCpus: 8, memoryMb: 32_768 });
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
}

async function publish(
  db: ReturnType<typeof drizzle<typeof schema>>,
  policy: { gbPerVcpu: number; minGb: number } | undefined,
  generation: number
) {
  stubCompute();
  const offerings = await gcpProvider(policy).listInstanceOfferings({
    preferApi: true,
    allowStaticFallback: false,
  });
  // A catalog refresh advances the source's catalog generation before it publishes.
  sqlite!.exec(
    `UPDATE capacity_sources SET source_generation = ${generation} WHERE id = '${SOURCE_ID}'`
  );
  return ensureCandidatesForSource(db, POOL_ID, SOURCE_ID, 'gcp', offerings, {
    sourceGeneration: generation,
    sourceAuthorityGeneration: VERSION,
  });
}

async function workspaceCandidate(db: ReturnType<typeof drizzle<typeof schema>>) {
  const [row] = await db
    .select()
    .from(schema.capacityPoolCandidates)
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, POOL_ID),
        eq(schema.capacityPoolCandidates.workloadRole, 'workspace')
      )
    );
  if (!row) throw new Error('workspace candidate was not published');
  return row;
}

/** The pool selection the TaskRunner builds from the current candidate row. */
function selectionFor(row: schema.CapacityPoolCandidate): TaskStartCapacityPoolSelection {
  const candidate = {
    ...row,
    capacitySourceGeneration: VERSION,
    capacitySourceExternalRef: null,
    placementCredentialSource: 'user',
    placementCredentialReference: 'credentials:gcp-cred',
    placementCredentialVersion: VERSION,
    capacityPoolProjectId: null,
    credentialAttributionSource: 'user',
    capacityAuthorityGeneration: null,
  };
  return {
    poolId: POOL_ID,
    scope: 'user',
    revision: 4,
    strategy: 'pack',
    exhaustionPolicy: 'fallback-chain',
    effectiveState: 'configured-ready',
    capacityPoolProjectId: null,
    workloadRole: 'workspace',
    candidates: [candidate],
  } as unknown as TaskStartCapacityPoolSelection;
}

/** A node provisioned from the candidate as it was published before this change (50 GB). */
function seedNode(row: schema.CapacityPoolCandidate): void {
  sqlite!.exec(`
    INSERT INTO nodes (id, user_id, name, status, runtime, vm_size, vm_location, cloud_provider,
      provider_instance_id, node_role, node_class, workload_role, capacity_pool_id,
      capacity_pool_scope, capacity_pool_revision, capacity_source_id, capacity_source_generation,
      capacity_source_external_ref, capacity_pool_candidate_id, capacity_pool_project_id,
      placement_credential_source, placement_credential_reference, placement_credential_version,
      provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
      provider_instance_disk_gb, provider_instance_boot_disk_size_gb, provider_instance_image,
      provider_instance_architecture, observed_provider_instance_disk_gb, health_status,
      heartbeat_stale_after_seconds, node_mode, created_at, updated_at)
    VALUES ('node-old', '${USER_ID}', 'Node', 'running', 'vm', 'large', '${ZONE}', 'gcp', 'i-1',
      'workspace', 'managed', 'workspace', '${POOL_ID}', 'user', 4, '${SOURCE_ID}', ${VERSION},
      NULL, '${row.id}', NULL, 'user', 'credentials:gcp-cred', ${VERSION}, 't2d-standard-8', 8,
      32768, ${row.providerInstanceDiskGb}, NULL, NULL, NULL, ${row.providerInstanceDiskGb},
      'healthy', 180, 'shared', '${TS}', '${TS}');
  `);
}

async function reusable(database: D1Database, row: schema.CapacityPoolCandidate) {
  const [node] = await drizzle(database, { schema })
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, 'node-old'));
  const snapshot = resolveReusableNodeCapacitySnapshot({
    selection: selectionFor(row),
    node: node as never,
    projectId: PROJECT_ID,
    requestedVmSize: 'large',
  });
  if (!snapshot) return new Set<string>();
  return filterReusableNodesByCurrentAuthority(database, {
    userId: USER_ID,
    projectId: PROJECT_ID,
    selections: [{ nodeId: 'node-old', capacityPlacementSnapshot: snapshot }],
  });
}

describe('GCP boot disk: catalog refresh, reuse and the created VM agree', () => {
  /** Publishes the pre-change 50 GB catalog, picks the candidate, and seeds a node from it. */
  async function legacyNodeOnPublishedCandidate() {
    const { database, db } = setup();
    // max(50, 1 x 8) = 50: what the fixed 50 GB disk advertised before this change.
    await publish(db, { gbPerVcpu: 1, minGb: 50 }, 1);
    const legacy = await workspaceCandidate(db);
    expect(legacy).toMatchObject({
      providerInstanceDiskGb: 50,
      providerInstanceBootDiskSizeGb: null,
    });
    sqlite!.exec(
      `UPDATE capacity_pool_candidates SET status = 'active' WHERE pool_id = '${POOL_ID}'`
    );
    seedNode(legacy);
    expect(await reusable(database, await workspaceCandidate(db))).toEqual(new Set(['node-old']));
    return { database, db, legacyId: legacy.id };
  }

  it('republishes the candidate at 160 GB and keeps the running 50 GB node reusable', async () => {
    const { database, db, legacyId } = await legacyNodeOnPublishedCandidate();

    await publish(db, undefined, 2);
    const refreshed = await workspaceCandidate(db);
    expect(refreshed).toMatchObject({
      id: legacyId,
      status: 'active',
      providerInstanceDiskGb: 160,
      providerInstanceBootDiskSizeGb: null,
    });

    expect(await reusable(database, refreshed)).toEqual(new Set(['node-old']));
    // The node keeps the capacity it was created with.
    const node = sqlite!
      .prepare('SELECT provider_instance_disk_gb AS disk FROM nodes WHERE id = ?')
      .get('node-old') as { disk: number };
    expect(node.disk).toBe(50);
  });

  it('control: writing the size to the boot-disk column instead would refuse the node', async () => {
    const { database, db } = await legacyNodeOnPublishedCandidate();
    await publish(db, undefined, 2);
    sqlite!.exec(
      `UPDATE capacity_pool_candidates SET provider_instance_boot_disk_size_gb = 160 WHERE pool_id = '${POOL_ID}'`
    );
    expect(await reusable(database, await workspaceCandidate(db))).toEqual(new Set());
  });

  it('a new plan from the refreshed candidate creates and records a 160 GB VM', async () => {
    const { db } = await legacyNodeOnPublishedCandidate();
    await publish(db, undefined, 2);
    const refreshed = await workspaceCandidate(db);

    const inserted: string[] = [];
    stubCompute(inserted);
    const vm = await gcpProvider().createVM(
      applyNativePlanToVmConfig(
        { name: 'node-new', location: ZONE, userData: '#cloud-config\n', size: 'large' },
        refreshed
      )
    );

    expect(inserted).toEqual(['160']);
    expect(observedHardwareDbValues(vm).observedProviderInstanceDiskGb).toBe(160);
    // The plan resolved against the candidate snapshot carries the same disk.
    const snapshot = capacityPlacementSnapshotForCandidate(
      selectionFor(refreshed),
      selectionFor(refreshed).candidates[0]!
    );
    expect(snapshot.providerInstanceDiskGb).toBe(160);
  });
});
