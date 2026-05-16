/**
 * Tests for node agent health check in TaskRunner DO.
 *
 * The task runner checks VM agent readiness via D1 heartbeat records instead
 * of fetching the VM agent directly. This avoids Cloudflare same-zone
 * subrequest routing, which intercepted Worker fetch() calls to single-level
 * vm-* subdomains. Now mitigated by two-level subdomains ({nodeId}.vm.{domain})
 * but D1 health checks remain as defense-in-depth.
 *
 * The VM agent sends POST /api/nodes/:id/ready on startup and
 * POST /api/nodes/:id/heartbeat periodically, both updating D1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isNodeAgentReadyForWorkspaceDispatch } from '../../src/durable-objects/task-runner/readiness';

const doSource = [
  'index.ts',
  'types.ts',
  'node-steps.ts',
  'workspace-steps.ts',
  'agent-session-step.ts',
  'state-machine.ts',
  'helpers.ts',
].map(f => readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner', f), 'utf8')).join('\n');

describe('verifyNodeAgentHealthy helper', () => {
  const section = (() => {
    const start = doSource.indexOf('export async function verifyNodeAgentHealthy(');
    const end = doSource.indexOf('async function tryClaimWarmNode(');
    return doSource.slice(start, end);
  })();

  it('exists as an exported function', () => {
    expect(section).toContain('export async function verifyNodeAgentHealthy(');
  });

  it('queries D1 for health_status and last_heartbeat_at', () => {
    expect(section).toContain('health_status');
    expect(section).toContain('last_heartbeat_at');
    expect(section).toContain('agent_ready_at');
    expect(section).toContain('rc.env.DATABASE.prepare');
  });

  it('does NOT fetch the VM agent directly (same-zone bypass)', () => {
    // Health checks use D1 not fetch — defense-in-depth against same-zone routing
    expect(section).not.toContain('fetch(');
    expect(section).not.toContain('AbortController');
  });

  it('checks heartbeat age against stale threshold', () => {
    expect(section).toContain('NODE_HEARTBEAT_STALE_SECONDS');
    expect(section).toContain('heartbeatAge');
  });

  it('returns false when node is not healthy', () => {
    expect(section).toContain("health_status !== 'healthy'");
    expect(section).toContain('return false');
  });

  it('returns false on database error', () => {
    expect(section).toContain('catch');
    expect(section).toContain('return false');
  });
});

describe('handleNodeAgentReady D1-based health check', () => {
  const agentReadySection = (() => {
    const start = doSource.indexOf('export async function handleNodeAgentReady(');
    const end = doSource.indexOf('export async function handleWorkspaceCreation(');
    return doSource.slice(start, end);
  })();

  it('queries D1 for node health status', () => {
    expect(agentReadySection).toContain('rc.env.DATABASE.prepare');
    expect(agentReadySection).toContain('health_status');
    expect(agentReadySection).toContain('last_heartbeat_at');
    expect(agentReadySection).toContain('agent_ready_at');
  });

  it('does NOT fetch the VM agent directly (same-zone bypass)', () => {
    expect(agentReadySection).not.toContain("fetch(healthUrl");
    expect(agentReadySection).not.toContain('VM_AGENT_PROTOCOL');
  });

  it('verifies heartbeat is recent (not stale from previous boot)', () => {
    expect(agentReadySection).toContain('isNodeAgentReadyForWorkspaceDispatch');
    expect(agentReadySection).toContain('agentReadyStartedAt');
  });

  it('advances to workspace_creation when heartbeat is healthy and recent', () => {
    expect(agentReadySection).toContain("advanceToStep(state, 'workspace_creation')");
  });

  it('logs stale heartbeat for observability', () => {
    expect(agentReadySection).toContain('task_runner_do.step.node_agent_ready.stale_heartbeat');
  });

  it('schedules another poll when not ready', () => {
    expect(agentReadySection).toContain('rc.getAgentPollIntervalMs()');
  });

  it('documents the same-zone routing issue in comments', () => {
    expect(agentReadySection).toContain('same-zone routing');
    expect(agentReadySection).toContain('wildcard Worker route');
  });
});

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

  it('does not accept a stale /ready signal from an earlier provisioning cycle', () => {
    const staleReady = readyRow({
      agent_ready_at: isoAt(-120_000),
    });

    expect(isNodeAgentReadyForWorkspaceDispatch(staleReady, waitStartedAt)).toBe(false);
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
        && readyOffset > -30_000;

      expect(isNodeAgentReadyForWorkspaceDispatch(row, waitStartedAt)).toBe(expected);
    }
  });
});

describe('handleNodeSelection health pre-checks for node reuse', () => {
  const nodeSelectionSection = (() => {
    const start = doSource.indexOf('export async function handleNodeSelection(');
    const end = doSource.indexOf('export async function handleNodeProvisioning(');
    return doSource.slice(start, end);
  })();

  it('verifies preferred node agent health before reusing', () => {
    const preferredSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('preferredNodeId'),
      nodeSelectionSection.indexOf('tryClaimWarmNode')
    );
    expect(preferredSection).toContain('verifyNodeAgentHealthy(node.id,');
  });

  it('verifies warm node agent health after claiming', () => {
    const warmSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('tryClaimWarmNode'),
      nodeSelectionSection.indexOf('findNodeWithCapacity')
    );
    expect(warmSection).toContain('verifyNodeAgentHealthy(nodeId,');
  });

  it('verifies existing node agent health before reusing', () => {
    const existingSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('findNodeWithCapacity'),
      nodeSelectionSection.indexOf('node_provisioning')
    );
    expect(existingSection).toContain('verifyNodeAgentHealthy(existingNodeId,');
  });

  it('logs warning when warm node fails health check', () => {
    expect(nodeSelectionSection).toContain('task_runner_do.warm_node_unhealthy');
  });

  it('logs warning when existing node fails health check', () => {
    expect(nodeSelectionSection).toContain('task_runner_do.existing_node_unhealthy');
  });

  it('falls through to provisioning when reusable nodes fail health checks', () => {
    expect(nodeSelectionSection).toContain("advanceToStep(state, 'node_provisioning')");
  });

  it('throws permanent error when preferred node fails health check', () => {
    expect(nodeSelectionSection).toContain('Specified node is not reachable');
  });
});
