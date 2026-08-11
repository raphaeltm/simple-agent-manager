import type { PlacementExplanation } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  persistTaskPlacement,
  recordPlacementFailure,
  recordProvisioningAttempt,
} from '../../../src/durable-objects/task-runner/placement';
import {
  persistTrialPlacement,
  recordTrialPlacementFailure,
  recordTrialProvisioningAttempt,
} from '../../../src/durable-objects/trial-orchestrator/placement';

function explanation(
  outcome: PlacementExplanation['outcome'] = 'provisioned'
): PlacementExplanation {
  return {
    schemaVersion: 2,
    outcome,
    selectionPath: outcome === 'reused' ? 'capacity' : 'provisioning',
    selectedNodeId: outcome === 'reused' ? 'node-reused' : null,
    summary: outcome === 'reused' ? 'Reused node-reused.' : 'Provisioning a new node.',
    request: {
      runtime: 'vm',
      vmSize: 'medium',
      vmLocation: 'hel1',
      maxWorkspacesPerNode: 5,
      cpuThresholdPercent: 50,
      memoryThresholdPercent: 50,
      heartbeatStaleSeconds: 180,
    },
    evaluatedNodes: [],
    provisioningAttempts: [],
    decidedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function persistenceContext() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const storagePut = vi.fn();
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              writes.push({ sql, values });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return {
    writes,
    storagePut,
    context: { env: { DATABASE: database }, ctx: { storage: { put: storagePut } } },
  };
}

describe('placement persistence vertical slices', () => {
  it('persists a reused TaskRunner decision to D1 and durable state', async () => {
    const harness = persistenceContext();
    const state = { taskId: 'task-1' };
    const reused = explanation('reused');

    await persistTaskPlacement(state as never, harness.context as never, reused);

    expect(state).toMatchObject({ placementExplanation: reused });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.sql).toContain('UPDATE tasks SET placement_explanation_json');
    expect(JSON.parse(harness.writes[0]?.values[0] as string)).toEqual(reused);
    expect(harness.storagePut).toHaveBeenCalledWith('state', state);
  });

  it('appends provisioning success and terminal failure to TaskRunner evidence', async () => {
    const harness = persistenceContext();
    const state = { taskId: 'task-2', placementExplanation: explanation() };

    await recordProvisioningAttempt(
      state as never,
      harness.context as never,
      { vmSize: 'medium', vmLocation: 'hel1', outcome: 'succeeded' },
      'node-new'
    );
    await recordPlacementFailure(state as never, harness.context as never, 'readiness-timeout');

    expect(state.placementExplanation).toMatchObject({
      outcome: 'failed',
      selectedNodeId: 'node-new',
      provisioningAttempts: [
        { outcome: 'succeeded' },
        { outcome: 'failed', failureReason: 'readiness-timeout' },
      ],
    });
    expect(harness.writes).toHaveLength(2);
  });

  it('persists trial placement before a workspace exists and retains failures', async () => {
    const harness = persistenceContext();
    const state = { trialId: 'trial-1' };

    await persistTrialPlacement(state as never, harness.context as never, explanation());
    await recordTrialProvisioningAttempt(state as never, harness.context as never, {
      vmSize: 'large',
      vmLocation: 'hel1',
      outcome: 'capacity-rejected',
    });
    await recordTrialPlacementFailure(state as never, harness.context as never, 'provider-failed');

    expect(harness.writes[0]?.sql).toContain('UPDATE trials SET placement_explanation_json');
    expect(state).toMatchObject({
      placementExplanation: {
        outcome: 'failed',
        provisioningAttempts: [
          { outcome: 'capacity-rejected', vmSize: 'large' },
          { outcome: 'failed', failureReason: 'provider-failed' },
        ],
      },
    });
    expect(harness.writes).toHaveLength(3);
  });
});
