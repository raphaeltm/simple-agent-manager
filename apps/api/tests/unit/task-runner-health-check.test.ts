/**
 * Tests for node agent health check identity validation in TaskRunner DO.
 *
 * The health check must verify that the response is from the actual VM agent
 * (which includes a `nodeId` field) and not from the API Worker's own /health
 * endpoint (which also returns 200 but lacks `nodeId`). This prevents the
 * task runner from advancing to workspace_creation when the VM agent is not
 * actually ready — a bug caused by Cloudflare same-zone subrequest routing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('verifyNodeAgentHealthy helper', () => {
  it('exists as a private method', () => {
    expect(doSource).toContain('private async verifyNodeAgentHealthy(nodeId: string): Promise<boolean>');
  });

  it('fetches the VM agent health endpoint using env-configured protocol and port', () => {
    const section = doSource.slice(
      doSource.indexOf('private async verifyNodeAgentHealthy('),
      doSource.indexOf('private async tryClaimWarmNode(')
    );
    expect(section).toContain("this.env.VM_AGENT_PROTOCOL || 'https'");
    expect(section).toContain("this.env.VM_AGENT_PORT || '8443'");
    expect(section).toContain('/health');
  });

  it('validates response contains matching nodeId', () => {
    const section = doSource.slice(
      doSource.indexOf('private async verifyNodeAgentHealthy('),
      doSource.indexOf('private async tryClaimWarmNode(')
    );
    expect(section).toContain('body.nodeId === nodeId');
  });

  it('returns false on non-ok response', () => {
    const section = doSource.slice(
      doSource.indexOf('private async verifyNodeAgentHealthy('),
      doSource.indexOf('private async tryClaimWarmNode(')
    );
    expect(section).toContain('if (!response.ok) return false');
  });

  it('returns false on fetch error (network failure, timeout)', () => {
    const section = doSource.slice(
      doSource.indexOf('private async verifyNodeAgentHealthy('),
      doSource.indexOf('private async tryClaimWarmNode(')
    );
    expect(section).toContain('catch');
    expect(section).toContain('return false');
  });

  it('uses a 5-second timeout to avoid blocking', () => {
    const section = doSource.slice(
      doSource.indexOf('private async verifyNodeAgentHealthy('),
      doSource.indexOf('private async tryClaimWarmNode(')
    );
    expect(section).toContain('setTimeout(() => controller.abort(), 5000)');
  });
});

describe('handleNodeAgentReady identity validation', () => {
  const agentReadySection = (() => {
    const start = doSource.indexOf('private async handleNodeAgentReady(');
    const end = doSource.indexOf('private async handleWorkspaceCreation(');
    return doSource.slice(start, end);
  })();

  it('parses health response body as JSON', () => {
    expect(agentReadySection).toContain('response.json()');
  });

  it('checks nodeId in response matches expected node', () => {
    expect(agentReadySection).toContain('body.nodeId === state.stepResults.nodeId');
  });

  it('does NOT advance to workspace_creation if nodeId does not match', () => {
    // The advanceToStep call must be INSIDE the identityVerified check
    expect(agentReadySection).toContain('if (identityVerified)');
    expect(agentReadySection).toContain("advanceToStep(state, 'workspace_creation')");
  });

  it('logs identity mismatch as a warning for observability', () => {
    expect(agentReadySection).toContain('task_runner_do.step.node_agent_ready.identity_mismatch');
  });

  it('falls through to schedule another poll on identity mismatch', () => {
    // After the identity mismatch warning, control should fall through
    // to the "schedule another poll" setAlarm at the bottom
    expect(agentReadySection).toContain('this.getAgentPollIntervalMs()');
  });
});

describe('handleNodeSelection health pre-checks for node reuse', () => {
  const nodeSelectionSection = (() => {
    const start = doSource.indexOf('private async handleNodeSelection(');
    const end = doSource.indexOf('private async handleNodeProvisioning(');
    return doSource.slice(start, end);
  })();

  it('verifies preferred node agent health before reusing', () => {
    // The preferred node path must call verifyNodeAgentHealthy
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
    // Warm and existing node paths should fall through (not throw)
    // when health check fails, allowing the system to provision a new node
    expect(nodeSelectionSection).toContain("advanceToStep(state, 'node_provisioning')");
  });

  it('throws permanent error when preferred node fails health check', () => {
    expect(nodeSelectionSection).toContain('Specified node is not reachable');
  });
});
