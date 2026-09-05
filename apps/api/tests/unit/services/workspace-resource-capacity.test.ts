import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  aggregateWorkspaceReservationRows,
  emptyWorkspaceReservationUsage,
  hasWorkspaceReservationCapacity,
  parseResolvedResourceReservation,
} from '../../../src/services/workspace-resource-capacity';

const REQUEST: ResolvedResourceReservation = {
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 40_960,
  exclusiveNode: false,
  maxCoTenants: 4,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

const CX23 = {
  providerInstanceVcpuCount: 2,
  providerInstanceMemoryMb: 4_096,
  providerInstanceDiskGb: 40,
};

describe('workspace resource capacity', () => {
  it('parses only complete integer reservation snapshots', () => {
    expect(parseResolvedResourceReservation(JSON.stringify(REQUEST))).toEqual(REQUEST);
    expect(parseResolvedResourceReservation(null)).toBeNull();
    expect(parseResolvedResourceReservation('{broken')).toBeNull();
    expect(
      parseResolvedResourceReservation(JSON.stringify({ ...REQUEST, memoryMb: '4096' }))
    ).toBeNull();
    expect(
      parseResolvedResourceReservation(JSON.stringify({ ...REQUEST, exclusiveNode: 0 }))
    ).toBeNull();
  });

  it('sums complete active reservations and marks malformed rows unknown', () => {
    expect(
      aggregateWorkspaceReservationRows([
        { resolvedReservationJson: JSON.stringify(REQUEST) },
        {
          resolvedReservationJson: JSON.stringify({
            ...REQUEST,
            cpuMillis: 1_000,
            memoryMb: 2_048,
            diskMb: 20_480,
            maxCoTenants: 2,
          }),
        },
        { resolvedReservationJson: null },
      ])
    ).toEqual({
      activeCount: 3,
      cpuMillis: 3_000,
      memoryMb: 6_144,
      diskMb: 61_440,
      hasExclusiveReservation: false,
      hasInvalidReservation: true,
      minimumMaxCoTenants: 2,
    });
  });

  it('allows one empty legacy-node placement but never unknown co-tenancy', () => {
    expect(hasWorkspaceReservationCapacity({}, emptyWorkspaceReservationUsage(), REQUEST, 4)).toBe(
      true
    );
    expect(
      hasWorkspaceReservationCapacity(
        {},
        aggregateWorkspaceReservationRows([{ resolvedReservationJson: JSON.stringify(REQUEST) }]),
        REQUEST,
        4
      )
    ).toBe(false);
  });

  it('enforces aggregate resources and exclusivity independently of the count cap', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify(REQUEST) },
    ]);
    expect(hasWorkspaceReservationCapacity(CX23, occupied, REQUEST, 4)).toBe(false);
    expect(
      hasWorkspaceReservationCapacity(
        {
          providerInstanceVcpuCount: 4,
          providerInstanceMemoryMb: 8_192,
          providerInstanceDiskGb: 80,
        },
        occupied,
        REQUEST,
        4
      )
    ).toBe(true);
    expect(
      hasWorkspaceReservationCapacity(
        {
          providerInstanceVcpuCount: 8,
          providerInstanceMemoryMb: 16_384,
          providerInstanceDiskGb: 160,
        },
        occupied,
        { ...REQUEST, exclusiveNode: true, maxCoTenants: 1 },
        10
      )
    ).toBe(false);
  });

  it('enforces both the platform count cap and every reservation co-tenant cap', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify({ ...REQUEST, maxCoTenants: 2 }) },
    ]);
    const largeNode = {
      providerInstanceVcpuCount: 8,
      providerInstanceMemoryMb: 16_384,
      providerInstanceDiskGb: 160,
    };

    expect(hasWorkspaceReservationCapacity(largeNode, occupied, REQUEST, 1)).toBe(false);
    expect(hasWorkspaceReservationCapacity(largeNode, occupied, REQUEST, 10)).toBe(true);
    expect(
      hasWorkspaceReservationCapacity(largeNode, occupied, { ...REQUEST, maxCoTenants: 1 }, 10)
    ).toBe(false);
    expect(
      hasWorkspaceReservationCapacity(
        largeNode,
        aggregateWorkspaceReservationRows([
          { resolvedReservationJson: JSON.stringify({ ...REQUEST, maxCoTenants: 1 }) },
        ]),
        REQUEST,
        10
      )
    ).toBe(false);
  });

  it('treats missing disk capacity conservatively once a node is occupied', () => {
    const occupied = aggregateWorkspaceReservationRows([
      { resolvedReservationJson: JSON.stringify(REQUEST) },
    ]);
    expect(
      hasWorkspaceReservationCapacity(
        {
          providerInstanceVcpuCount: 8,
          providerInstanceMemoryMb: 16_384,
          providerInstanceDiskGb: null,
        },
        occupied,
        REQUEST,
        10
      )
    ).toBe(false);
  });
});
