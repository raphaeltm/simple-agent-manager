/**
 * Integration tests for node selection subsystem (TDF-3).
 *
 * Source contract tests verifying cross-module wiring:
 * 1. Concurrent warm pool claiming: two tasks try to claim same node
 * 2. D1 state changes between query and claim
 * 3. Node selector -> NodeLifecycle DO -> D1 state coordination
 *
 * These tests validate the wiring between modules, not the individual
 * function behavior (which is covered by unit tests).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const selectorSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-selector.ts'),
  'utf8'
);
const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/node-lifecycle.ts'),
  'utf8'
);
const serviceSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-lifecycle.ts'),
  'utf8'
);
const taskRunnerSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

// =============================================================================
// Concurrent warm pool claiming — safety mechanisms
// =============================================================================

describe('concurrent warm pool claiming safety', () => {
  describe('NodeLifecycle DO tryClaim is the single point of truth', () => {
    it('tryClaim only succeeds when status is warm', () => {
      const tryClaimSection = doSource.slice(
        doSource.indexOf('async tryClaim('),
        doSource.indexOf('async getStatus(')
      );
      expect(tryClaimSection).toContain("state.status !== 'warm'");
      expect(tryClaimSection).toContain('claimed: false');
    });

    it('tryClaim transitions warm -> active atomically via DO storage', () => {
      const tryClaimSection = doSource.slice(
        doSource.indexOf('async tryClaim('),
        doSource.indexOf('async getStatus(')
      );
      // State update via storage.put is atomic within a DO
      expect(tryClaimSection).toContain("state.status = 'active'");
      expect(tryClaimSection).toContain("this.ctx.storage.put('state', state)");
    });

    it('tryClaim sets claimedByTask for traceability', () => {
      const tryClaimSection = doSource.slice(
        doSource.indexOf('async tryClaim('),
        doSource.indexOf('async getStatus(')
      );
      expect(tryClaimSection).toContain('state.claimedByTask = taskId');
    });

    it('second claim on same node returns claimed: false (already active)', () => {
      // Once tryClaim succeeds, status is 'active'. Next tryClaim sees
      // status !== 'warm' and returns false.
      const tryClaimSection = doSource.slice(
        doSource.indexOf('async tryClaim('),
        doSource.indexOf('async getStatus(')
      );
      expect(tryClaimSection).toContain("state.status !== 'warm'");
      expect(tryClaimSection).toContain('{ claimed: false, state: this.toPublicState(state) }');
    });

    it('tryClaim returns false for null state (uninitialized DO)', () => {
      const tryClaimSection = doSource.slice(
        doSource.indexOf('async tryClaim('),
        doSource.indexOf('async getStatus(')
      );
      expect(tryClaimSection).toContain('if (!state)');
      expect(tryClaimSection).toContain('claimed: false');
    });
  });

  describe('defense-in-depth: D1 re-check before DO call', () => {
    it('selectNodeForTaskRun re-queries D1 before each tryClaim', () => {
      const warmSection = selectorSource.slice(
        selectorSource.indexOf('for (const warmNode'),
        selectorSource.indexOf('Get all running nodes')
      );
      // The defense-in-depth check re-queries D1
      expect(warmSection).toContain('freshNode');
      expect(warmSection).toContain("eq(schema.nodes.id, warmNode.id)");
    });

    it('skips node if D1 shows status changed to non-running', () => {
      const warmSection = selectorSource.slice(
        selectorSource.indexOf('for (const warmNode'),
        selectorSource.indexOf('Get all running nodes')
      );
      expect(warmSection).toContain("freshNode.status !== 'running'");
      expect(warmSection).toContain('continue');
    });

    it('skips node if D1 shows warmSince cleared', () => {
      const warmSection = selectorSource.slice(
        selectorSource.indexOf('for (const warmNode'),
        selectorSource.indexOf('Get all running nodes')
      );
      expect(warmSection).toContain('!freshNode.warmSince');
      expect(warmSection).toContain('continue');
    });

    it('skips node if D1 query returns no results', () => {
      const warmSection = selectorSource.slice(
        selectorSource.indexOf('for (const warmNode'),
        selectorSource.indexOf('Get all running nodes')
      );
      expect(warmSection).toContain('!freshNode');
      expect(warmSection).toContain('continue');
    });
  });

  describe('TaskRunner DO warm claiming uses same pattern', () => {
    it('TaskRunner tryClaimWarmNode re-checks D1 freshness', () => {
      const section = taskRunnerSource.slice(
        taskRunnerSource.indexOf('private async tryClaimWarmNode('),
        taskRunnerSource.indexOf('private async findNodeWithCapacity(')
      );
      expect(section).toContain("status = 'running' AND warm_since IS NOT NULL");
      // Fresh check query
      expect(section).toContain("WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL");
    });

    it('TaskRunner tryClaimWarmNode claims via NodeLifecycle DO stub', () => {
      const section = taskRunnerSource.slice(
        taskRunnerSource.indexOf('private async tryClaimWarmNode('),
        taskRunnerSource.indexOf('private async findNodeWithCapacity(')
      );
      expect(section).toContain('NODE_LIFECYCLE.idFromName(warmNode.id)');
      expect(section).toContain('stub.tryClaim(state.taskId)');
    });

    it('TaskRunner tryClaimWarmNode catches claim failures and tries next', () => {
      const section = taskRunnerSource.slice(
        taskRunnerSource.indexOf('private async tryClaimWarmNode('),
        taskRunnerSource.indexOf('private async findNodeWithCapacity(')
      );
      expect(section).toContain('} catch {');
    });

    it('TaskRunner tryClaimWarmNode returns null if no warm node claimed', () => {
      const section = taskRunnerSource.slice(
        taskRunnerSource.indexOf('private async tryClaimWarmNode('),
        taskRunnerSource.indexOf('private async findNodeWithCapacity(')
      );
      expect(section).toContain('return null');
    });
  });

  describe('NodeLifecycle service wrapper', () => {
    it('service.tryClaim uses idFromName for deterministic DO mapping', () => {
      expect(serviceSource).toContain('env.NODE_LIFECYCLE.idFromName(nodeId)');
    });

    it('service.tryClaim forwards taskId to DO stub', () => {
      expect(serviceSource).toContain('stub.tryClaim(taskId)');
    });

    it('selectNodeForTaskRun uses service.tryClaim (not direct DO access)', () => {
      expect(selectorSource).toContain('nodeLifecycle.tryClaim');
      expect(selectorSource).toContain("import * as nodeLifecycle from './node-lifecycle'");
    });
  });
});

// =============================================================================
// End-to-end node selection flow: selection -> provisioning wiring
// =============================================================================

describe('node selection to provisioning flow wiring', () => {
  it('selectNodeForTaskRun returns null when no node available (triggers provisioning)', () => {
    // selectNodeForTaskRun returns null in two places
    const nullReturns = selectorSource.match(/return null/g);
    expect(nullReturns).not.toBeNull();
    expect(nullReturns!.length).toBeGreaterThanOrEqual(2); // zero nodes, no capacity
  });

  it('TaskRunner handleNodeSelection falls through to provisioning on null', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async handleNodeSelection('),
      taskRunnerSource.indexOf('private async handleNodeProvisioning(')
    );
    // When no node found, advance to provisioning
    expect(section).toContain("advanceToStep(state, 'node_provisioning')");
  });

  it('TaskRunner handleNodeSelection tries warm pool before capacity', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async handleNodeSelection('),
      taskRunnerSource.indexOf('private async handleNodeProvisioning(')
    );
    const warmIdx = section.indexOf('tryClaimWarmNode');
    const capacityIdx = section.indexOf('findNodeWithCapacity');
    expect(warmIdx).toBeGreaterThan(-1);
    expect(capacityIdx).toBeGreaterThan(warmIdx);
  });

  it('TaskRunner handleNodeSelection checks preferred node before warm pool', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async handleNodeSelection('),
      taskRunnerSource.indexOf('private async handleNodeProvisioning(')
    );
    const preferredIdx = section.indexOf('preferredNodeId');
    const warmIdx = section.indexOf('tryClaimWarmNode');
    expect(preferredIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeGreaterThan(preferredIdx);
  });

  it('preferred node check validates status is running', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async handleNodeSelection('),
      taskRunnerSource.indexOf('tryClaimWarmNode')
    );
    expect(section).toContain("node.status !== 'running'");
    expect(section).toContain('permanent: true');
  });

  it('preferred node check validates ownership (user_id match)', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async handleNodeSelection('),
      taskRunnerSource.indexOf('tryClaimWarmNode')
    );
    expect(section).toContain('user_id = ?');
    expect(section).toContain('state.userId');
  });
});

// =============================================================================
// Capacity scoring consistency between selector and TaskRunner
// =============================================================================

describe('capacity scoring consistency', () => {
  it('both selector and TaskRunner use same 0.4/0.6 weighting', () => {
    // node-selector.ts
    expect(selectorSource).toContain('cpu * 0.4 + memory * 0.6');

    // task-runner.ts findNodeWithCapacity
    const trSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async findNodeWithCapacity(')
    );
    expect(trSection).toContain('cpu * 0.4 + mem * 0.6');
  });

  it('both use same location-first then size-then-load sorting order', () => {
    // node-selector.ts
    const selectorSort = selectorSource.slice(
      selectorSource.indexOf('Sort candidates'),
      selectorSource.indexOf('return candidates[0]')
    );
    expect(selectorSort).toContain('aLocationMatch');

    // task-runner.ts
    const trSort = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async findNodeWithCapacity('),
      taskRunnerSource.indexOf('// ====', taskRunnerSource.indexOf('private async findNodeWithCapacity(') + 100)
    );
    expect(trSort).toContain('aLoc');
    expect(trSort).toContain('aSize');
  });

  it('both check workspace count against max per node', () => {
    expect(selectorSource).toContain('maxWorkspacesPerNode');
    const trSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async findNodeWithCapacity(')
    );
    expect(trSection).toContain('maxWsPerNode');
  });

  it('both skip unhealthy nodes', () => {
    expect(selectorSource).toContain("node.healthStatus === 'unhealthy'");
    const trSection = taskRunnerSource.slice(
      taskRunnerSource.indexOf('private async findNodeWithCapacity(')
    );
    expect(trSection).toContain("health_status != 'unhealthy'");
  });
});
