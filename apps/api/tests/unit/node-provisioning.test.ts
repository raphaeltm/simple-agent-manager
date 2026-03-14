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
      expect(section).toContain("SELECT COUNT(*) as c FROM nodes WHERE user_id = ? AND status IN ('running', 'creating', 'recovery')");
    });

    it('only counts active nodes (excludes deleted/stopped) in limit check', () => {
      const section = doSource.slice(
        doSource.indexOf('private async handleNodeProvisioning('),
        doSource.indexOf('private async handleNodeAgentReady(')
      );
      // Must filter by active statuses to avoid false limit hits from deleted/stopped nodes.
      // See: 2026-03-09-fix-node-workspace-limit-count-filters
      expect(section).toContain("status IN ('running', 'creating', 'recovery')");
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

  it('checks health via D1 heartbeat query (not direct VM fetch)', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('this.env.DATABASE.prepare');
    expect(section).toContain('health_status');
    expect(section).toContain('last_heartbeat_at');
    // Must NOT use direct fetch to VM (same-zone routing intercepts it)
    expect(section).not.toContain('fetch(healthUrl');
  });

  it('verifies heartbeat is recent (not stale from previous boot)', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('heartbeatIsRecent');
    expect(section).toContain('agentReadyStartedAt');
  });

  it('advances to workspace_creation on healthy + recent heartbeat', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain("health_status === 'healthy'");
    expect(section).toContain("advanceToStep(state, 'workspace_creation')");
  });

  it('schedules poll alarm when not ready', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('this.getAgentPollIntervalMs()');
    expect(section).toContain('setAlarm');
  });

  it('documents same-zone routing issue in comments', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeAgentReady('),
      doSource.indexOf('private async handleWorkspaceCreation(')
    );
    expect(section).toContain('same-zone routing');
  });
});

// =============================================================================
// Task context passed to cloud-init (TDF message relay fix)
// =============================================================================

describe('task context passed to provisionNode for cloud-init', () => {
  it('passes projectId to provisionNode call', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('state.projectId');
    expect(section).toContain('provisionNode');
  });

  it('passes chatSessionId from step results to provisionNode', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('chatSessionId');
    expect(section).toContain('state.stepResults.chatSessionId');
  });

  it('passes taskId to provisionNode call', () => {
    const section = doSource.slice(
      doSource.indexOf('private async handleNodeProvisioning('),
      doSource.indexOf('private async handleNodeAgentReady(')
    );
    expect(section).toContain('state.taskId');
  });
});

// =============================================================================
// Provider-aware node creation and error observability
// =============================================================================

describe('provider-aware node provisioning', () => {
  const nodesSource = readFileSync(
    resolve(process.cwd(), 'src/services/nodes.ts'),
    'utf8'
  );

  it('CreateNodeInput includes optional cloudProvider field', () => {
    expect(nodesSource).toContain('cloudProvider?: string');
  });

  it('ProvisionedNode includes cloudProvider field', () => {
    expect(nodesSource).toContain('cloudProvider: string | null');
  });

  it('createNodeRecord stores cloudProvider in DB insert', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function createNodeRecord'),
      nodesSource.indexOf('async function provisionNode')
    );
    expect(section).toContain('cloudProvider: input.cloudProvider');
  });

  it('provisionNode reads cloudProvider from node record for credential lookup', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function provisionNode'),
      nodesSource.indexOf('async function stopNodeResources')
    );
    expect(section).toContain('node.cloudProvider as CredentialProvider');
    expect(section).toContain('targetProvider');
  });

  it('provisionNode passes targetProvider to getUserCloudProviderConfig', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function provisionNode'),
      nodesSource.indexOf('async function stopNodeResources')
    );
    expect(section).toContain('getUserCloudProviderConfig(db, node.userId, env.ENCRYPTION_KEY, targetProvider)');
  });

  it('provisionNode persists error to observability database on failure', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function provisionNode'),
      nodesSource.indexOf('async function stopNodeResources')
    );
    expect(section).toContain('persistError(env.OBSERVABILITY_DATABASE');
    expect(section).toContain("source: 'api'");
    expect(section).toContain("component: 'node-provisioning'");
  });

  it('provisionNode stores detailed error message in node record (not generic)', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function provisionNode'),
      nodesSource.indexOf('async function stopNodeResources')
    );
    expect(section).toContain('`[${providerName}] ${truncatedError}`');
    // Must NOT use the old generic message
    expect(section).not.toContain("errorMessage: 'Node provisioning failed'");
  });

  it('provisionNode includes provider and statusCode in console.error context', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function provisionNode'),
      nodesSource.indexOf('async function stopNodeResources')
    );
    expect(section).toContain('provider: providerName');
    expect(section).toContain('statusCode');
  });

  it('stopNodeResources uses node cloudProvider for credential lookup', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function stopNodeResources'),
      nodesSource.indexOf('async function deleteNodeResources')
    );
    expect(section).toContain('node.cloudProvider as CredentialProvider');
    expect(section).toContain('getUserCloudProviderConfig(db, userId, env.ENCRYPTION_KEY, targetProvider)');
  });

  it('deleteNodeResources uses node cloudProvider for credential lookup', () => {
    const section = nodesSource.slice(
      nodesSource.indexOf('async function deleteNodeResources')
    );
    expect(section).toContain('node.cloudProvider as CredentialProvider');
    expect(section).toContain('getUserCloudProviderConfig(db, userId, env.ENCRYPTION_KEY, targetProvider)');
  });
});

// =============================================================================
// provisionNode accepts task context (nodes.ts)
// =============================================================================

describe('provisionNode task context', () => {
  const nodesSource = readFileSync(
    resolve(process.cwd(), 'src/services/nodes.ts'),
    'utf8'
  );

  it('defines ProvisionTaskContext interface with projectId, chatSessionId, taskId', () => {
    expect(nodesSource).toContain('export interface ProvisionTaskContext');
    expect(nodesSource).toContain('projectId: string');
    expect(nodesSource).toContain('chatSessionId: string');
    expect(nodesSource).toContain('taskId: string');
  });

  it('provisionNode accepts optional taskContext parameter', () => {
    expect(nodesSource).toContain('taskContext?: ProvisionTaskContext');
  });

  it('passes taskContext projectId to generateCloudInit', () => {
    expect(nodesSource).toContain('taskContext?.projectId');
  });

  it('passes taskContext chatSessionId to generateCloudInit', () => {
    expect(nodesSource).toContain('taskContext?.chatSessionId');
  });

  it('passes taskContext taskId to generateCloudInit', () => {
    expect(nodesSource).toContain('taskContext?.taskId');
  });
});
