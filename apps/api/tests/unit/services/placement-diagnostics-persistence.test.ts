import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleAdmissionWait } from '../../../src/durable-objects/task-runner/node-provisioning-admission';
import { persistPlacementDiagnostics } from '../../../src/durable-objects/task-runner/placement-diagnostics';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { buildPlacementDecisionDiagnostics } from '../../../src/services/placement-diagnostics';
import { publicPlacementExplanationJson } from '../../../src/services/public-placement-explanation';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const dbs: Database.Database[] = [];
function setup() {
  const sqlite = new Database(':memory:');
  dbs.push(sqlite);
  sqlite.exec(`CREATE TABLE tasks (id TEXT, project_id TEXT, user_id TEXT, placement_explanation_json TEXT);
    INSERT INTO tasks VALUES ('task', 'project', 'user', '{"originalIntent":"keep"}');`);
  const state = {
    taskId: 'task',
    projectId: 'project',
    userId: 'user',
    config: { resourceRequirements: { minVcpu: 1.5, minMemoryGb: 2, minDiskGb: 4 } },
    stepResults: { nodeId: null },
  } as unknown as TaskRunnerState;
  const rc = {
    env: { DATABASE: createSqliteD1(sqlite) },
    ctx: { storage: { put: vi.fn(), setAlarm: vi.fn() } },
    updateD1ExecutionStep: vi.fn(),
  } as unknown as TaskRunnerContext;
  const read = () =>
    JSON.parse(
      (
        sqlite.prepare('SELECT placement_explanation_json FROM tasks').get() as {
          placement_explanation_json: string;
        }
      ).placement_explanation_json
    );
  return { sqlite, state, rc, read };
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('placement diagnostics through persisted task state', () => {
  it('publishes a queued run before a workspace exists and keeps original audit fields', async () => {
    const { state, rc, read } = setup();
    await scheduleAdmissionWait(state, rc, {
      kind: 'waiting',
      reason: 'provider_account_capacity',
      nextRetryAt: '2026-09-07T15:01:00Z',
      waitDeadlineAt: '2026-09-07T15:05:00Z',
    });
    expect(read()).toMatchObject({
      originalIntent: 'keep',
      diagnostics: {
        version: 1,
        selectedNodeId: null,
        requested: { cpuMillis: 1500, memoryMb: 2048, diskMb: 4096, evidence: 'requested' },
        queue: {
          state: 'waiting',
          reason: 'provider_account_capacity',
          nextRetryAt: '2026-09-07T15:01:00Z',
        },
        authority: { revalidatedAgainstCurrentAuthority: false },
      },
    });
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalledWith(Date.parse('2026-09-07T15:01:00Z'));
  });

  it('keeps attempt history on wake, clears waiting, and marks authority only after a successful fence', async () => {
    const { state, rc, read } = setup();
    await persistPlacementDiagnostics(state, rc, {
      attempts: [
        {
          order: 1,
          provider: 'hetzner',
          location: 'fsn1',
          providerInstanceType: 'cx42',
          outcome: 'capacity-exhausted',
          reason: 'Offering capacity exhausted',
        },
        {
          order: 2,
          provider: 'hetzner',
          location: 'nbg1',
          providerInstanceType: 'cx42',
          outcome: 'succeeded',
          reason: null,
        },
      ],
      queue: { state: 'waiting' },
    });
    state.stepResults.nodeId = 'selected-node';
    await persistPlacementDiagnostics(state, rc, {
      queue: {},
      revalidatedAgainstCurrentAuthority: true,
    });
    expect(read().diagnostics).toMatchObject({
      selectedNodeId: 'selected-node',
      queue: { state: null },
      authority: { revalidatedAgainstCurrentAuthority: true },
    });
    expect(read().diagnostics.attempts.map((a: { outcome: string }) => a.outcome)).toEqual([
      'capacity-exhausted',
      'succeeded',
    ]);
  });

  it('keeps internal source and credential references out of the public explanation', async () => {
    const { state, rc, read } = setup();
    await persistPlacementDiagnostics(state, rc);
    const internal = JSON.stringify({
      ...read(),
      capacitySourceId: 'secret-source-reference',
      placementCredentialReference: 'credential-canary',
    });
    const publicJson = publicPlacementExplanationJson(internal);
    expect(JSON.parse(publicJson!)).toHaveProperty('diagnostics.requested.cpuMillis', 1500);
    expect(publicJson).not.toContain('secret-source-reference');
    expect(publicJson).not.toContain('credential-canary');
    expect(
      publicPlacementExplanationJson(
        JSON.stringify({ diagnostics: { version: 1, token: 'canary' } })
      )
    ).toBeNull();
  });

  it('cannot write another user or project task explanation', async () => {
    const { state, rc, read } = setup();
    state.userId = 'another-user';
    await persistPlacementDiagnostics(state, rc, { notes: ['Wrong owner'] });
    expect(read()).toEqual({ originalIntent: 'keep' });
  });

  it('allows only public pool fields out of the credential-bearing selection', () => {
    const canary = 'secret-credential-canary';
    const result = buildPlacementDecisionDiagnostics({
      requestedReservation: null,
      selection: {
        poolId: 'pool',
        scope: 'installation',
        revision: 2,
        effectiveState: 'configured-ready',
        strategy: 'pack',
        exhaustionPolicy: 'queue',
        capacitySourceId: canary,
        placementCredentialReference: canary,
        candidates: [{ token: canary }],
      } as never,
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.authority.strategyOrdering).toBe('highest projected utilization first');
    expect(result.authority.revalidatedAgainstCurrentAuthority).toBe(false);
  });
});
