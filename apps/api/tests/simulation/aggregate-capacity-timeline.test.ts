import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_STALE_HEARTBEAT_POLICY,
  AggregateCapacityTimeline,
  CURRENT_AGGREGATE_CAPACITY_POLICY,
  NO_FINAL_CAPACITY_CAS_POLICY,
  OVERLAPPING_PROVISIONING_POLICY,
} from './aggregate-capacity-timeline-harness';

const HALF_NODE: ResolvedResourceReservation = {
  cpuMillis: 2_000,
  memoryMb: 4_096,
  diskMb: 40_960,
  exclusiveNode: false,
  maxCoTenants: 4,
  source: 'platform',
  sourceId: 'platform',
  version: 1,
};

const LARGE_NODE = {
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8_192,
  providerInstanceDiskGb: 80,
};

const FULL_NODE: ResolvedResourceReservation = {
  ...HALF_NODE,
  cpuMillis: 4_000,
  memoryMb: 8_192,
  diskMb: 81_920,
  maxCoTenants: 1,
};

function exactSnapshot(world: AggregateCapacityTimeline, taskId: string): string | null {
  return world.workspaces.get(`workspace-${taskId}`)?.resolvedReservationJson ?? null;
}

describe('aggregate capacity deterministic virtual timeline', () => {
  it('serializes concurrent full-node reservations', () => {
    const world = new AggregateCapacityTimeline();
    world.addNode('node-1', LARGE_NODE);
    world.submit('full-a', FULL_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.submit('full-b', FULL_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.runUntilIdle();

    expect(world.tasks.get('full-a')?.status).toBe('running');
    expect(world.tasks.get('full-b')?.status).toBe('retry-wait');
    expect(world.activeWorkspaces('node-1')).toHaveLength(1);
    world.assertSafety();
  });

  it('serializes contenders that both observe the last remaining capacity', () => {
    const world = new AggregateCapacityTimeline();
    world.addNode('node-1', LARGE_NODE);
    world.submit('existing', HALF_NODE, { preferredNodeId: 'node-1' });
    world.runUntilIdle();

    world.submit('contender-a', HALF_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.submit('contender-b', HALF_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.runUntilIdle();

    expect(world.tasks.get('contender-a')?.status).toBe('running');
    expect(world.tasks.get('contender-b')?.status).toBe('retry-wait');
    expect(world.activeWorkspaces('node-1')).toHaveLength(2);
    world.assertSafety();
  });

  it('rejects stale nodes until a delayed heartbeat makes them eligible', () => {
    const world = new AggregateCapacityTimeline();
    world.addNode('node-stale', LARGE_NODE, { lastHeartbeatAt: world.now - 30_001 });

    world.submit('delayed', HALF_NODE, { preferredNodeId: 'node-stale' });
    expect(world.tasks.get('delayed')?.status).toBe('retry-wait');
    world.scheduleHeartbeat('node-stale', 5_000);
    world.runUntilIdle();
    world.retry('delayed', { preferredNodeId: 'node-stale' });
    world.runUntilIdle();

    expect(world.tasks.get('delayed')?.status).toBe('running');
    world.assertSafety();
  });

  it('serializes overlapping provisioning and releases capacity on cancellation or failure', () => {
    const world = new AggregateCapacityTimeline();
    world.submit('provision-a', HALF_NODE, { provisionIfUnavailable: true });
    world.submit('provision-b', HALF_NODE, { provisionIfUnavailable: true });

    expect(world.providerRequests).toHaveLength(1);
    world.cancel('provision-b');
    world.runUntilIdle();
    world.retry('provision-a');
    world.runUntilIdle();
    expect(world.tasks.get('provision-a')?.status).toBe('running');

    world.fail('provision-a');
    world.submit('replacement', HALF_NODE, { preferredNodeId: 'node-provisioned-0' });
    world.runUntilIdle();
    expect(world.tasks.get('replacement')?.status).toBe('running');
    world.assertNoProvisioningOverlap();
    world.assertSafety();
  });

  it('makes retries idempotent and persists the exact pre-resolved snapshot', () => {
    const world = new AggregateCapacityTimeline();
    world.addNode('node-1', LARGE_NODE);
    const exact = { ...HALF_NODE, source: 'task' as const, sourceId: 'task-exact-snapshot' };
    world.submit('retry', exact, { preferredNodeId: 'node-1' });
    world.runUntilIdle();
    world.submit(
      'retry',
      { ...exact, sourceId: 'mutated-after-resolution' },
      {
        preferredNodeId: 'node-1',
      }
    );
    world.runUntilIdle();

    expect(world.activeWorkspaces('node-1')).toHaveLength(1);
    expect(exactSnapshot(world, 'retry')).toBe(JSON.stringify(exact));
    world.assertSafety();
  });

  it('fails closed for occupied legacy/malformed data and enforces exclusivity', () => {
    for (const legacyJson of [null, '{broken']) {
      const world = new AggregateCapacityTimeline();
      world.addNode('node-legacy', LARGE_NODE);
      world.seedWorkspace({
        id: `legacy-${String(legacyJson)}`,
        nodeId: 'node-legacy',
        reservationJson: legacyJson,
      });
      world.submit('denied', HALF_NODE, { preferredNodeId: 'node-legacy' });
      expect(world.tasks.get('denied')?.status).toBe('retry-wait');
    }

    const world = new AggregateCapacityTimeline();
    world.addNode('node-exclusive', LARGE_NODE);
    const exclusive = { ...HALF_NODE, exclusiveNode: true, maxCoTenants: 1 };
    world.submit('exclusive', exclusive, { preferredNodeId: 'node-exclusive' });
    world.runUntilIdle();
    world.submit('co-tenant', HALF_NODE, { preferredNodeId: 'node-exclusive' });
    expect(world.tasks.get('co-tenant')?.status).toBe('retry-wait');
    world.assertSafety();
  });
});

describe('aggregate capacity simulation calibration', () => {
  it('detects removal of the final capacity recheck', () => {
    const world = new AggregateCapacityTimeline(NO_FINAL_CAPACITY_CAS_POLICY);
    world.addNode('node-1', LARGE_NODE);
    world.submit('existing', HALF_NODE, { preferredNodeId: 'node-1' });
    world.runUntilIdle();
    world.submit('contender-a', HALF_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.submit('contender-b', HALF_NODE, { preferredNodeId: 'node-1', commitDelayMs: 10 });
    world.runUntilIdle();

    expect(() => world.assertSafety()).toThrow(/capacity exceeded/);
  });

  it('detects accepting a stale heartbeat', () => {
    const world = new AggregateCapacityTimeline(ACCEPT_STALE_HEARTBEAT_POLICY);
    world.addNode('node-stale', LARGE_NODE, { lastHeartbeatAt: world.now - 30_001 });
    world.submit('unsafe-stale-placement', HALF_NODE, { preferredNodeId: 'node-stale' });
    world.runUntilIdle();

    expect(() => world.assertSafety()).toThrow(/stale heartbeat/);
  });

  it('detects removal of the provisioning lease', () => {
    const world = new AggregateCapacityTimeline(OVERLAPPING_PROVISIONING_POLICY);
    world.submit('provision-a', HALF_NODE, { provisionIfUnavailable: true });
    world.submit('provision-b', HALF_NODE, { provisionIfUnavailable: true });

    expect(() => world.assertNoProvisioningOverlap()).toThrow(/overlapped/);
  });

  it('keeps the current policy as the calibrated control', () => {
    const world = new AggregateCapacityTimeline(CURRENT_AGGREGATE_CAPACITY_POLICY);
    world.addNode('node-1', LARGE_NODE);
    world.submit('control', HALF_NODE, { preferredNodeId: 'node-1' });
    world.runUntilIdle();

    expect(() => world.assertSafety()).not.toThrow();
    expect(() => world.assertNoProvisioningOverlap()).not.toThrow();
  });
});
