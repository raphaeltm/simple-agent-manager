/**
 * Executable readiness tests for TaskRunner node-agent dispatch gating.
 *
 * This file intentionally avoids source-text assertions. Static TaskRunner
 * wiring is covered separately in task-runner-static-wiring.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { isNodeAgentReadyForWorkspaceDispatch } from '../../src/durable-objects/task-runner/readiness';

describe('isNodeAgentReadyForWorkspaceDispatch', () => {
  const waitStartedAt = Date.parse('2026-05-16T15:30:30.000Z');
  const isoAt = (offsetMs: number) => new Date(waitStartedAt + offsetMs).toISOString();
  const readyRow = (
    overrides: Partial<NonNullable<Parameters<typeof isNodeAgentReadyForWorkspaceDispatch>[0]>>
  ) => ({
    status: 'running',
    health_status: 'healthy',
    last_heartbeat_at: isoAt(5_000),
    agent_ready_at: isoAt(5_000),
    ...overrides,
  });

  it('recreates the debug-package failure: early heartbeat alone is not workspace-ready', () => {
    const earlyHeartbeatOnly = readyRow({
      agent_ready_at: null,
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(earlyHeartbeatOnly, waitStartedAt)).toBe(false);
  });

  it('allows workspace dispatch after the VM agent sends /ready', () => {
    const afterReady = readyRow({
      last_heartbeat_at: isoAt(80_000),
      agent_ready_at: isoAt(79_000),
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(afterReady, waitStartedAt)).toBe(true);
  });

  it('accepts an older /ready signal when the node is still sending fresh heartbeats', () => {
    const readyBeforePollingStarted = readyRow({
      agent_ready_at: isoAt(-120_000),
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(readyBeforePollingStarted, waitStartedAt)).toBe(true);
  });

  it('does not accept a stale heartbeat even when /ready was sent earlier', () => {
    const staleHeartbeat = readyRow({
      last_heartbeat_at: isoAt(-120_000),
      agent_ready_at: isoAt(-125_000),
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(staleHeartbeat, waitStartedAt)).toBe(false);
  });

  it('does not accept /ready when it is implausibly ahead of the latest heartbeat', () => {
    const futureReady = readyRow({
      last_heartbeat_at: isoAt(5_000),
      agent_ready_at: isoAt(45_001),
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(futureReady, waitStartedAt)).toBe(false);
  });

  it('rejects unhealthy, creating, and malformed node records', () => {
    expect(isNodeAgentReadyForWorkspaceDispatch(null, waitStartedAt)).toBe(false);
    expect(isNodeAgentReadyForWorkspaceDispatch(readyRow({
      status: 'creating',
    }), waitStartedAt)).toBe(false);
    expect(isNodeAgentReadyForWorkspaceDispatch(readyRow({
      health_status: 'unhealthy',
    }), waitStartedAt)).toBe(false);
    expect(isNodeAgentReadyForWorkspaceDispatch(readyRow({
      last_heartbeat_at: 'not-a-date',
    }), waitStartedAt)).toBe(false);
  });

  it('matches the readiness invariant across randomized signal timings', () => {
    let seed = 0x5a17;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let i = 0; i < 250; i += 1) {
      const heartbeatOffset = Math.floor(next() * 240_000) - 120_000;
      const readyOffset = Math.floor(next() * 240_000) - 120_000;
      const status = next() < 0.1 ? 'creating' : 'running';
      const healthStatus = next() < 0.1 ? 'stale' : 'healthy';
      const missingReady = next() < 0.2;
      const missingHeartbeat = next() < 0.1;

      const row = readyRow({
        status,
        health_status: healthStatus,
        last_heartbeat_at: missingHeartbeat ? null : isoAt(heartbeatOffset),
        agent_ready_at: missingReady ? null : isoAt(readyOffset),
      });
      const expected = status === 'running'
        && healthStatus === 'healthy'
        && row.last_heartbeat_at !== null
        && row.agent_ready_at !== null
        && heartbeatOffset > -30_000
        && readyOffset <= heartbeatOffset + 30_000;

      expect(isNodeAgentReadyForWorkspaceDispatch(row, waitStartedAt)).toBe(expected);
    }
  });
});
