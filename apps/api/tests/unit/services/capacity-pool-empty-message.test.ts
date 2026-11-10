/**
 * The refusal for a VM task against a pool with no machines, for every pool scope:
 *
 * - exact strings through `noEligibleCapacityCandidateMessage` (placement-resolution-error.ts);
 * - the same strings through the real allocation entry point (`resolveCanonicalVmAllocationPlan`)
 *   when every account of a pool is switched off, on a real SQLite engine. Each scope has a
 *   control from the same fixture that proves the pool had machines before the switch.
 *
 * `canonical-vm-allocation.ts` keeps its own copy of the non-empty message; only the
 * configured-empty branch is shared (`emptyCapacityPoolMessage`).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveCanonicalVmAllocationPlan } from '../../../src/services/canonical-vm-allocation';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import {
  emptyCapacityPoolMessage,
  noEligibleCapacityCandidateMessage,
} from '../../../src/services/placement-resolution-error';
import {
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../../src/services/placement-resolver';
import type { TaskStartCapacityPoolSelection } from '../../../src/services/placement-resolver-types';
import { offering } from '../../helpers/capacity-pool-offerings';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedPlatformCloudCredential,
  seedProjectWithMember,
  seedUser,
} from '../routes/capacity-pool-test-seeds';

type Scope = TaskStartCapacityPoolSelection['scope'];

const EXPECTED: Record<Scope, string> = {
  project:
    "This project's compute pool has no machines, so work that needs a VM cannot start. Add machines to it in its infrastructure settings, or run this as an Instant session.",
  user: 'Your compute pool has no machines, so work that needs a VM cannot start. Add machines to it in its infrastructure settings, or run this as an Instant session.',
  installation:
    'The shared compute pool has no machines, so work that needs a VM cannot start. Ask an admin to add machines to it, or run this as an Instant session.',
};

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('emptyCapacityPoolMessage / noEligibleCapacityCandidateMessage', () => {
  const placement = (overrides: Record<string, unknown> = {}) =>
    ({
      resolvedReservation: { cpuMillis: 2000, memoryMb: 4096, diskMb: 15 * 1024 },
      provider: null,
      explicitVmLocation: false,
      vmLocation: 'fsn1',
      ...overrides,
    }) as never;
  const selection = (scope: Scope, effectiveState: string) =>
    ({ scope, effectiveState, candidates: [] }) as unknown as TaskStartCapacityPoolSelection;

  it.each(Object.entries(EXPECTED) as Array<[Scope, string]>)(
    'says the %s pool has no machines, in exactly these words',
    (scope, message) => {
      expect(emptyCapacityPoolMessage(scope)).toBe(message);
      expect(
        noEligibleCapacityCandidateMessage(placement(), selection(scope, 'configured-empty'))
      ).toBe(message);
    }
  );

  it.each(['project', 'user', 'installation'] as const)(
    'keeps the requirements message for a %s pool that has machines but none that fit',
    (scope) => {
      const message = noEligibleCapacityCandidateMessage(
        placement({ provider: 'hetzner', explicitVmLocation: true }),
        selection(scope, 'configured-ready')
      );
      expect(message).toBe(
        `No eligible compute-pool offering is available in the ${scope} default pool provider hetzner location fsn1 for this task's requirements (2 vCPU, 4096 MB memory, 15 GB disk). Reconcile the pool or add an active provider-native offering that satisfies the request.`
      );
      expect(message).not.toContain('has no machines');
    }
  );
});

describe('every account switched off, through the real allocation entry point', () => {
  const SCOPE_FOR = {
    project: { scope: 'project', ownerUserId: null, ownerProjectId: 'project-1' },
    user: { scope: 'user', ownerUserId: 'user-1', ownerProjectId: null },
    installation: { scope: 'installation', ownerUserId: null, ownerProjectId: null },
  } as const;

  async function fixture(scope: Scope) {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user-1');
    if (scope === 'project') {
      seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
      for (const id of ['cloud-a', 'cloud-b']) {
        seedCloudCredential(sqlite, { id, userId: 'user-1', projectId: 'project-1' });
      }
    } else if (scope === 'user') {
      for (const id of ['cloud-a', 'cloud-b'])
        seedCloudCredential(sqlite, { id, userId: 'user-1' });
    } else {
      seedPlatformCloudCredential(sqlite);
    }
    const database = createSqliteD1WithBindLimit(sqlite, 100);
    const d1 = drizzle(database, { schema });
    const env = { DATABASE: database } as unknown as Env;
    await ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
      userId: 'user-1',
      projectId: scope === 'project' ? 'project-1' : null,
      includeInstallation: scope === 'installation',
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => [offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR' })],
    });
    // The person picks every listed machine, as the editor does.
    const poolScope = SCOPE_FOR[scope];
    const picked = await updateDefaultCapacityPool(d1 as never, {
      ...poolScope,
      candidates: (
        sqlite
          .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace'")
          .all() as Array<{ id: string }>
      ).map(({ id }) => ({ id, status: 'active' as const })),
    });
    expect(picked.conflict).toBe(false);
    const sourceIds = (
      sqlite
        .prepare('SELECT id FROM capacity_sources WHERE scope = ? ORDER BY id')
        .all(scope) as Array<{ id: string }>
    ).map((row) => row.id);
    expect(sourceIds.length).toBeGreaterThanOrEqual(1);

    const allocate = () =>
      resolveCanonicalVmAllocationPlan(d1 as never, env, {
        entryPoint: 'direct-workspace',
        taskId: 'task-empty-pool',
        userId: 'user-1',
        projectId: scope === 'project' ? 'project-1' : null,
        project:
          scope === 'project'
            ? {
                id: 'project-1',
                defaultProvider: null,
                defaultLocation: null,
                defaultVmSize: 'small',
              }
            : null,
        credentialProjectPolicy:
          scope === 'project' ? 'current-project' : 'current-project-unless-inherited',
        taskModeDefault: 'task',
        workloadRole: 'workspace',
        capacityPoolEnsure: false,
      });
    const selectionNow = () =>
      resolveTaskStartCapacityPoolSelection(
        d1 as never,
        resolveTaskStartPlacement({
          entryPoint: 'direct-workspace',
          taskId: 'task-empty-pool',
          projectId: scope === 'project' ? 'project-1' : '',
          userId: 'user-1',
          project: {
            id: scope === 'project' ? 'project-1' : '',
            defaultProvider: null,
            defaultVmSize: 'small',
          },
          credentialProjectPolicy: 'current-project',
          taskModeDefault: 'task',
          resourceRequirements: {},
        }),
        { ensure: false, failOpen: false, env }
      );
    const switchOff = (excludedSourceIds: string[]) =>
      updateDefaultCapacityPool(d1 as never, { ...poolScope, excludedSourceIds });
    return { sourceIds, allocate, selectionNow, switchOff };
  }

  it.each(['project', 'user', 'installation'] as const)(
    'refuses a VM allocation with the %s message once every account is off, and not before',
    async (scope) => {
      const { sourceIds, allocate, selectionNow, switchOff } = await fixture(scope);

      // Control: with the accounts on, the pool has machines for the same call.
      const before = await selectionNow();
      expect(before).toMatchObject({ scope, effectiveState: 'configured-ready' });
      expect(before?.candidates.length).toBeGreaterThan(0);

      const off = await switchOff(sourceIds);
      expect(off).toMatchObject({ conflict: false, missingSourceIds: [] });
      expect(off.summary?.pool.excludedSourceIds.sort()).toEqual([...sourceIds].sort());
      expect(off.summary?.effectiveState).toBe('configured-empty');

      const after = await selectionNow();
      expect(after).toMatchObject({ scope, effectiveState: 'configured-empty', candidates: [] });
      await expect(allocate()).resolves.toEqual({
        error: EXPECTED[scope],
        errorKind: 'placement',
      });
    }
  );

  it('keeps allocating at project scope while only one of two accounts is off (control)', async () => {
    const { sourceIds, selectionNow, switchOff } = await fixture('project');
    expect(sourceIds.length).toBe(2);

    await switchOff([sourceIds[0]!]);

    const selection = await selectionNow();
    expect(selection?.effectiveState).toBe('configured-ready');
    expect(selection?.candidates.map((c) => c.capacitySourceId)).toEqual([sourceIds[1]]);
  });
});
