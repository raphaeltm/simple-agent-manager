/**
 * Tests for node agent health check in TaskRunner DO.
 *
 * The task runner checks VM agent readiness via D1 heartbeat records instead
 * of fetching the VM agent directly. This avoids Cloudflare same-zone
 * subrequest routing, which intercepts Worker fetch() calls to vm-* hostnames
 * and routes them back to the API Worker instead of the VM agent.
 *
 * The VM agent sends POST /api/nodes/:id/ready on startup and
 * POST /api/nodes/:id/heartbeat periodically, both updating D1.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('verifyNodeAgentHealthy helper', () => {
  const section = (() => {
    const start = doSource.indexOf('private async verifyNodeAgentHealthy(');
    const end = doSource.indexOf('private async tryClaimWarmNode(');
    return doSource.slice(start, end);
  })();

  it('exists as a private method', () => {
    expect(section).toContain('private async verifyNodeAgentHealthy(nodeId: string): Promise<boolean>');
  });

  it('queries D1 for health_status and last_heartbeat_at', () => {
    expect(section).toContain('health_status');
    expect(section).toContain('last_heartbeat_at');
    expect(section).toContain('this.env.DATABASE.prepare');
  });

  it('does NOT fetch the VM agent directly (same-zone bypass)', () => {
    // The old approach used fetch() to vm-{nodeId}.domain — this MUST NOT be present
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
    const start = doSource.indexOf('private async handleNodeAgentReady(');
    const end = doSource.indexOf('private async handleWorkspaceCreation(');
    return doSource.slice(start, end);
  })();

  it('queries D1 for node health status', () => {
    expect(agentReadySection).toContain('this.env.DATABASE.prepare');
    expect(agentReadySection).toContain('health_status');
    expect(agentReadySection).toContain('last_heartbeat_at');
  });

  it('does NOT fetch the VM agent directly (same-zone bypass)', () => {
    expect(agentReadySection).not.toContain("fetch(healthUrl");
    expect(agentReadySection).not.toContain('VM_AGENT_PROTOCOL');
  });

  it('verifies heartbeat is recent (not stale from previous boot)', () => {
    expect(agentReadySection).toContain('heartbeatIsRecent');
    expect(agentReadySection).toContain('agentReadyStartedAt');
  });

  it('advances to workspace_creation when heartbeat is healthy and recent', () => {
    expect(agentReadySection).toContain("advanceToStep(state, 'workspace_creation')");
  });

  it('logs stale heartbeat for observability', () => {
    expect(agentReadySection).toContain('task_runner_do.step.node_agent_ready.stale_heartbeat');
  });

  it('schedules another poll when not ready', () => {
    expect(agentReadySection).toContain('this.getAgentPollIntervalMs()');
  });

  it('documents the same-zone routing issue in comments', () => {
    expect(agentReadySection).toContain('same-zone routing');
    expect(agentReadySection).toContain('wildcard Worker route');
  });
});

describe('handleNodeSelection health pre-checks for node reuse', () => {
  const nodeSelectionSection = (() => {
    const start = doSource.indexOf('private async handleNodeSelection(');
    const end = doSource.indexOf('private async handleNodeProvisioning(');
    return doSource.slice(start, end);
  })();

  it('verifies preferred node agent health before reusing', () => {
    const preferredSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('preferredNodeId'),
      nodeSelectionSection.indexOf('tryClaimWarmNode')
    );
    expect(preferredSection).toContain('verifyNodeAgentHealthy(node.id)');
  });

  it('verifies warm node agent health after claiming', () => {
    const warmSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('tryClaimWarmNode'),
      nodeSelectionSection.indexOf('findNodeWithCapacity')
    );
    expect(warmSection).toContain('verifyNodeAgentHealthy(nodeId)');
  });

  it('verifies existing node agent health before reusing', () => {
    const existingSection = nodeSelectionSection.slice(
      nodeSelectionSection.indexOf('findNodeWithCapacity'),
      nodeSelectionSection.indexOf('node_provisioning')
    );
    expect(existingSection).toContain('verifyNodeAgentHealthy(existingNodeId)');
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
