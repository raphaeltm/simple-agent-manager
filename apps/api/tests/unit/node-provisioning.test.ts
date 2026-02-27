/**
 * Source contract and behavioral tests for node provisioning flow (TDF-3).
 *
 * Validates:
 * 1. Node limit enforcement logic in TaskRunner DO
 * 2. Provisioning success path
 * 3. Hetzner API failure handling
 * 4. Retry behavior for already-provisioned nodes
 * 5. Health check timeout in handleNodeAgentReady
 *
 * Uses source contract tests for the DO step handlers (which can't be
 * instantiated directly) and behavioral tests for pure helper functions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvInt } from '../../src/durable-objects/task-runner-helpers';

const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

// =============================================================================
// Node Limit Enforcement
// =============================================================================

describe('node limit enforcement', () => {
  describe('MAX_NODES_PER_USER env var', () => {
    it('TaskRunner DO env type declares MAX_NODES_PER_USER as optional', () => {
      expect(doSource).toContain("MAX_NODES_PER_USER?: string");
    });

    it('handleNodeProvisioning reads MAX_NODES_PER_USER via parseEnvInt', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      expect(section).toContain('MAX_NODES_PER_USER');
      expect(section).toContain('parseEnvInt');
    });

    it('defaults to 10 when env var is not set', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      expect(section).toContain('parseEnvInt(this.env.MAX_NODES_PER_USER, 10)');
    });
  });

  describe('parseEnvInt for node limits', () => {
    it('returns 10 (default) when env var is undefined', () => {
      expect(parseEnvInt(undefined, 10)).toBe(10);
    });

    it('returns custom limit when env var is valid', () => {
      expect(parseEnvInt('5', 10)).toBe(5);
    });

    it('returns custom limit of 1 (minimum useful)', () => {
      expect(parseEnvInt('1', 10)).toBe(1);
    });

    it('returns default for zero (invalid)', () => {
      expect(parseEnvInt('0', 10)).toBe(10);
    });

    it('returns default for negative numbers', () => {
      expect(parseEnvInt('-3', 10)).toBe(10);
    });

    it('returns default for non-numeric string', () => {
      expect(parseEnvInt('unlimited', 10)).toBe(10);
    });

    it('returns 50 for large but valid limit', () => {
      expect(parseEnvInt('50', 10)).toBe(50);
    });
  });

  describe('limit check in handleNodeProvisioning', () => {
    it('queries node count for the user from D1', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      expect(section).toContain("SELECT COUNT(*) as c FROM nodes WHERE user_id = ?");
    });

    it('throws permanent error when at or over limit', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      expect(section).toContain('>= maxNodes');
      expect(section).toContain('Cannot auto-provision');
      expect(section).toContain('permanent: true');
    });

    it('error message includes the actual limit value', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      expect(section).toContain('`Maximum ${maxNodes} nodes allowed');
    });

    it('uses >= comparison (at limit = rejected)', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      // Verify it uses >= not >
      expect(section).toContain('>= maxNodes');
      expect(section).not.toContain('> maxNodes');
    });
  });
});

// =============================================================================
// Node Provisioning Success Path
// =============================================================================

describe('node provisioning success path', () => {
  it('dynamically imports createNodeRecord and provisionNode', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("import('../services/nodes')");
    expect(section).toContain('createNodeRecord');
    expect(section).toContain('provisionNode');
  });

  it('uses task title in auto-provisioned node name (truncated to 40 chars)', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("name: `Auto: ${state.config.taskTitle.slice(0, 40)}`");
  });

  it('sets autoProvisioned = true in step results', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('state.stepResults.autoProvisioned = true');
  });

  it('stores autoProvisionedNodeId on the task in D1', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('auto_provisioned_node_id');
    expect(section).toContain("UPDATE tasks SET auto_provisioned_node_id = ?");
  });

  it('persists state to DO storage after creating node', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("this.ctx.storage.put('state', state)");
  });

  it('verifies node is running after provisionNode call', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("provisionedNode.status !== 'running'");
  });

  it('advances to node_agent_ready after successful provisioning', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("advanceToStep(state, 'node_agent_ready')");
  });

  it('uses vmSize and vmLocation from task config', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('state.config.vmSize');
    expect(section).toContain('state.config.vmLocation');
  });
});

// =============================================================================
// Node Provisioning Failure Handling
// =============================================================================

describe('node provisioning failure handling', () => {
  it('throws error when provisioned node status is error', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("node?.status === 'error'");
    expect(section).toContain("node.error_message || 'Node provisioning failed'");
  });

  it('throws error when provisioned node status is stopped', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("node?.status === 'stopped'");
  });

  it('throws error when provisionedNode is null or not running', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("!provisionedNode || provisionedNode.status !== 'running'");
  });
});

// =============================================================================
// Retry for Already-Provisioned Node
// =============================================================================

describe('retry for already-provisioned node', () => {
  it('checks if nodeId already exists in step results (retry scenario)', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('if (state.stepResults.nodeId)');
  });

  it('queries node status from D1 on retry', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain("SELECT id, status, error_message FROM nodes WHERE id = ?");
  });

  it('advances immediately if node is already running on retry', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('// Check user node limit')
    );
    expect(section).toContain("node?.status === 'running'");
    expect(section).toContain("advanceToStep(state, 'node_agent_ready')");
  });

  it('schedules poll alarm if node is still creating', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('// Check user node limit')
    );
    expect(section).toContain('getProvisionPollIntervalMs()');
    expect(section).toContain('setAlarm');
  });
});

// =============================================================================
// handleNodeAgentReady — timeout and polling
// =============================================================================

describe('handleNodeAgentReady', () => {
  it('throws when nodeId is missing from state', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('No nodeId in state');
  });

  it('initializes agentReadyStartedAt on first entry', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('if (!state.agentReadyStartedAt)');
    expect(section).toContain('state.agentReadyStartedAt = Date.now()');
  });

  it('persists state after setting agentReadyStartedAt', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    // Find the section between agentReadyStartedAt assignment and the timeout check
    const startAtSection = section.slice(
      section.indexOf('agentReadyStartedAt = Date.now()'),
      section.indexOf('Check timeout')
    );
    expect(startAtSection).toContain("storage.put('state'");
  });

  it('throws permanent error when timeout is exceeded', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('elapsed > timeoutMs');
    expect(section).toContain('Node agent not ready within');
    expect(section).toContain('permanent: true');
  });

  it('uses configurable agent ready timeout', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('this.getAgentReadyTimeoutMs()');
  });

  it('checks health via HTTP GET to /health endpoint', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('/health');
    expect(section).toContain("method: 'GET'");
  });

  it('constructs health URL from nodeId and BASE_DOMAIN', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('state.stepResults.nodeId.toLowerCase()');
    expect(section).toContain('this.env.BASE_DOMAIN');
  });

  it('advances to workspace_creation on successful health check', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('response.ok');
    expect(section).toContain("advanceToStep(state, 'workspace_creation')");
  });

  it('schedules poll alarm on failed health check', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('this.getAgentPollIntervalMs()');
    expect(section).toContain('setAlarm');
  });

  it('uses AbortController with 5s timeout for health check request', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('AbortController');
    expect(section).toContain('5000');
    expect(section).toContain('controller.abort()');
  });
});
