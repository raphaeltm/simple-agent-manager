import { describe, expect, it } from 'vitest';

import { isPlacementExplanationV2, parsePlacementExplanationJson } from '../src/placement';

const validV2 = {
  schemaVersion: 2,
  outcome: 'reused',
  selectionPath: 'capacity',
  selectedNodeId: 'node-1',
  summary: 'Reused node node-1 through the capacity path.',
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

describe('parsePlacementExplanationJson', () => {
  it('parses a valid v2 placement record', () => {
    const parsed = parsePlacementExplanationJson(JSON.stringify(validV2));
    expect(parsed && isPlacementExplanationV2(parsed)).toBe(true);
    expect(parsed).toEqual(validV2);
  });

  it('round-trips high configured limits and typed provisioning timeouts', () => {
    const configured = {
      ...validV2,
      request: {
        ...validV2.request,
        maxWorkspacesPerNode: 20000,
        heartbeatStaleSeconds: 172800,
      },
      provisioningAttempts: [
        {
          vmSize: 'medium',
          vmLocation: 'hel1',
          outcome: 'failed',
          failureReason: 'provisioning-timeout',
        },
      ],
    };

    expect(parsePlacementExplanationJson(JSON.stringify(configured))).toEqual(configured);
  });

  it('parses a legacy placement record', () => {
    const canary = 'CANARY_LEGACY_SECRET';
    const parsed = parsePlacementExplanationJson(
      JSON.stringify({
        selectedVmSize: 'medium',
        vmSizeSource: 'project',
        reservation: {
          cpuMillis: 1000,
          memoryMb: 2048,
          diskMb: 4096,
          exclusiveNode: false,
          maxCoTenants: 5,
          source: 'project',
          sourceId: 'project-1',
          version: 1,
          providerError: canary,
        },
        reason: 'Legacy record',
        decidedAt: '2026-08-10T00:00:00.000Z',
        rawAgentVersion: canary,
      })
    );
    expect(parsed).toMatchObject({ reason: 'Legacy record' });
    expect(JSON.stringify(parsed)).not.toContain(canary);
    expect(parsed).not.toHaveProperty('rawAgentVersion');
    expect(parsed).not.toHaveProperty('reservation.providerError');
  });

  it.each([
    null,
    '',
    '{bad json',
    JSON.stringify({ ...validV2, schemaVersion: 99 }),
    JSON.stringify({ ...validV2, evaluatedNodes: [{ raw: 'unvalidated' }] }),
  ])('rejects absent or malformed data safely', (raw) => {
    expect(parsePlacementExplanationJson(raw)).toBeNull();
  });
});
