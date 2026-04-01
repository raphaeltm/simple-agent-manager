/**
 * Tests for node selection logic (TDF-3).
 *
 * Includes:
 * - Behavioral tests for nodeHasCapacity() and scoreNodeLoad() with actual function calls
 * - Source contract tests for selectNodeForTaskRun() algorithm structure
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NodeMetrics } from '@simple-agent-manager/shared';
import {
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';
import { describe, expect,it } from 'vitest';

import { nodeHasCapacity, scoreNodeLoad } from '../../src/services/node-selector';

// =============================================================================
// Behavioral tests — nodeHasCapacity()
// =============================================================================

describe('nodeHasCapacity', () => {
  const cpuThreshold = DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT; // 50
  const memThreshold = DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT; // 50

  it('returns true when all metrics are below thresholds', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 30, memoryPercent: 30, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(true);
  });

  it('returns false when CPU exceeds threshold', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 51, memoryPercent: 30, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(false);
  });

  it('returns false when memory exceeds threshold', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 30, memoryPercent: 51, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(false);
  });

  it('returns false when CPU equals threshold exactly', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 50, memoryPercent: 30, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(false);
  });

  it('returns false when memory equals threshold exactly', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 30, memoryPercent: 50, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(false);
  });

  it('returns true just below threshold', () => {
    const metrics: NodeMetrics = { cpuLoadAvg1: 49, memoryPercent: 49, diskPercent: 20 };
    expect(nodeHasCapacity(metrics, cpuThreshold, memThreshold)).toBe(true);
  });

  it('returns true with null metrics (node may still be starting up)', () => {
    expect(nodeHasCapacity(null, cpuThreshold, memThreshold)).toBe(true);
  });

  it('uses the correct default thresholds (50% CPU, 50% memory)', () => {
    expect(DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT).toBe(50);
    expect(DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT).toBe(50);
  });
});

// =============================================================================
// Behavioral tests — scoreNodeLoad()
// =============================================================================

describe('scoreNodeLoad', () => {
  it('returns null for null metrics', () => {
    expect(scoreNodeLoad(null)).toBeNull();
  });

  it('returns 0 for idle node', () => {
    expect(scoreNodeLoad({ cpuLoadAvg1: 0, memoryPercent: 0, diskPercent: 0 })).toBe(0);
  });

  it('weights memory 60% and CPU 40%', () => {
    const score = scoreNodeLoad({ cpuLoadAvg1: 100, memoryPercent: 0, diskPercent: 0 });
    expect(score).toBe(40); // 100 * 0.4 + 0 * 0.6

    const score2 = scoreNodeLoad({ cpuLoadAvg1: 0, memoryPercent: 100, diskPercent: 0 });
    expect(score2).toBe(60); // 0 * 0.4 + 100 * 0.6
  });

  it('computes weighted average correctly', () => {
    const score = scoreNodeLoad({ cpuLoadAvg1: 50, memoryPercent: 50, diskPercent: 50 });
    expect(score).toBe(50); // 50 * 0.4 + 50 * 0.6
  });
});

// =============================================================================
// Source contract tests
// =============================================================================

const selectorSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-selector.ts'),
  'utf8'
);

// =============================================================================
// Algorithm structure — warm pool path
// =============================================================================

describe('selectNodeForTaskRun warm pool path', () => {
  it('warm pool check runs before capacity check (Step 0 before regular query)', () => {
    const step0Idx = selectorSource.indexOf('Step 0');
    const regularQueryIdx = selectorSource.indexOf('Get all running nodes');
    expect(step0Idx).toBeGreaterThan(-1);
    expect(regularQueryIdx).toBeGreaterThan(step0Idx);
  });

  it('warm pool path is conditional on taskId AND NODE_LIFECYCLE binding', () => {
    expect(selectorSource).toContain('if (taskId && env.NODE_LIFECYCLE)');
  });

  it('queries only running nodes with non-null warmSince for the user', () => {
    const warmQuery = selectorSource.slice(
      selectorSource.indexOf('Step 0'),
      selectorSource.indexOf('sortedWarm')
    );
    expect(warmQuery).toContain("eq(schema.nodes.userId, userId)");
    expect(warmQuery).toContain("eq(schema.nodes.status, 'running')");
    expect(warmQuery).toContain("isNotNull(schema.nodes.warmSince)");
  });

  it('sorts warm nodes by size match first, then location match', () => {
    const sortSection = selectorSource.slice(
      selectorSource.indexOf('sortedWarm = warmNodes.sort'),
      selectorSource.indexOf('for (const warmNode')
    );
    // Size match is compared first
    expect(sortSection).toContain('aSizeMatch');
    expect(sortSection).toContain('bSizeMatch');
    // Then location match
    expect(sortSection).toContain('aLocMatch');
    expect(sortSection).toContain('bLocMatch');
    // Size uses preferredSize
    expect(sortSection).toContain('preferredSize');
    // Location uses preferredLocation
    expect(sortSection).toContain('preferredLocation');
  });

  it('iterates warm nodes and tries to claim each one', () => {
    expect(selectorSource).toContain('for (const warmNode of sortedWarm)');
    expect(selectorSource).toContain('nodeLifecycle.tryClaim');
  });

  it('defense-in-depth: re-checks D1 status before DO claim', () => {
    const warmSection = selectorSource.slice(
      selectorSource.indexOf('for (const warmNode'),
      selectorSource.indexOf('Get all running nodes')
    );
    // Re-queries D1 to verify node is still running and warm
    expect(warmSection).toContain('freshNode');
    expect(warmSection).toContain("freshNode.status !== 'running'");
    expect(warmSection).toContain("!freshNode.warmSince");
    expect(warmSection).toContain('continue');
  });

  it('returns the first successfully claimed warm node', () => {
    const warmSection = selectorSource.slice(
      selectorSource.indexOf('for (const warmNode'),
      selectorSource.indexOf('Get all running nodes')
    );
    expect(warmSection).toContain('result.claimed');
    expect(warmSection).toContain('return {');
    expect(warmSection).toContain('warmNode.id');
  });

  it('checks workspace count before returning claimed warm nodes', () => {
    const warmSection = selectorSource.slice(
      selectorSource.indexOf('for (const warmNode'),
      selectorSource.indexOf('Get all running nodes')
    );
    expect(warmSection).toContain('warmActiveCount >= maxWorkspacesPerNode');
    expect(warmSection).toContain('activeWorkspaceCount: warmActiveCount');
  });

  it('catches claim failures and tries the next warm node', () => {
    const warmSection = selectorSource.slice(
      selectorSource.indexOf('for (const warmNode'),
      selectorSource.indexOf('Get all running nodes')
    );
    expect(warmSection).toContain('} catch {');
  });

  it('falls through to capacity-based selection after all warm claims fail', () => {
    // After the warm node loop, the regular node query runs
    const afterWarmLoop = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(afterWarmLoop).toContain('.select()');
  });
});

// =============================================================================
// Algorithm structure — capacity-based path
// =============================================================================

describe('selectNodeForTaskRun capacity path', () => {
  it('queries all running nodes for the user', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain("eq(schema.nodes.userId, userId)");
    expect(capacitySection).toContain("eq(schema.nodes.status, 'running')");
  });

  it('returns null when no running nodes exist', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain('nodes.length === 0');
    expect(capacitySection).toContain('return null');
  });

  it('skips unhealthy nodes', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain("node.healthStatus === 'unhealthy'");
    expect(capacitySection).toContain('continue');
  });

  it('counts active workspaces per node (running, creating, recovery)', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain('count()');
    expect(capacitySection).toContain("'running', 'creating', 'recovery'");
  });

  it('filters candidates by nodeHasCapacity', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain('nodeHasCapacity(');
    expect(capacitySection).toContain('candidates.push(candidate)');
  });

  it('returns null when no candidates have capacity', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    expect(capacitySection).toContain('candidates.length === 0');
    expect(capacitySection).toContain('return null');
  });

  it('sorts candidates by location match, then size match, then load score', () => {
    const sortSection = selectorSource.slice(
      selectorSource.indexOf('Sort candidates'),
      selectorSource.indexOf('return candidates[0]')
    );
    // Location first
    expect(sortSection).toContain('aLocationMatch');
    expect(sortSection).toContain('bLocationMatch');
    // Size second
    expect(sortSection).toContain('aSizeMatch');
    expect(sortSection).toContain('bSizeMatch');
    // Load score last
    expect(sortSection).toContain('scoreNodeLoad');
    expect(sortSection).toContain('aScore');
    expect(sortSection).toContain('bScore');
  });

  it('returns the first candidate (lowest load, best match)', () => {
    expect(selectorSource).toContain('return candidates[0]!');
  });

  it('nodes with null metrics are ranked lower than nodes with scores', () => {
    const sortSection = selectorSource.slice(
      selectorSource.indexOf('Sort candidates'),
      selectorSource.indexOf('return candidates[0]')
    );
    // null scores go to end
    expect(sortSection).toContain('aScore === null');
    expect(sortSection).toContain('return 1'); // null goes after
    expect(sortSection).toContain('return -1'); // non-null goes before
  });
});

// =============================================================================
// Threshold configuration
// =============================================================================

describe('selectNodeForTaskRun threshold configuration', () => {
  it('reads CPU threshold from TASK_RUN_NODE_CPU_THRESHOLD_PERCENT env var', () => {
    expect(selectorSource).toContain('env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
  });

  it('reads memory threshold from TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT env var', () => {
    expect(selectorSource).toContain('env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('defaults CPU threshold to shared constant', () => {
    expect(selectorSource).toContain('DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
  });

  it('defaults memory threshold to shared constant', () => {
    expect(selectorSource).toContain('DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('parseThreshold rejects values < 0 or > 100', () => {
    // Verify the parseThreshold function is present and validates range
    expect(selectorSource).toContain('parsed < 0');
    expect(selectorSource).toContain('parsed > 100');
  });
});

// =============================================================================
// parseMetrics function
// =============================================================================

describe('parseMetrics (internal)', () => {
  it('returns null for null input', () => {
    expect(selectorSource).toContain('if (!raw) return null');
  });

  it('returns null for invalid JSON', () => {
    expect(selectorSource).toContain('} catch {');
    expect(selectorSource).toContain('return null');
  });

  it('validates the parsed object has at least one metric field', () => {
    expect(selectorSource).toContain("typeof parsed.cpuLoadAvg1 === 'number'");
    expect(selectorSource).toContain("typeof parsed.memoryPercent === 'number'");
    expect(selectorSource).toContain("typeof parsed.diskPercent === 'number'");
  });

  it('returns null for non-object parsed values', () => {
    expect(selectorSource).toContain("typeof parsed === 'object'");
    expect(selectorSource).toContain("parsed !== null");
  });
});

// =============================================================================
// Edge cases — structural validation
// =============================================================================

describe('selectNodeForTaskRun edge cases', () => {
  it('skips warm pool when taskId is undefined or NODE_LIFECYCLE binding is missing', () => {
    // Both conditions must be truthy for the warm pool path
    expect(selectorSource).toContain('if (taskId && env.NODE_LIFECYCLE)');
  });

  it('handles preferred size and location being undefined in warm sort', () => {
    // The ternary checks if preferredSize is defined before comparing
    const warmSort = selectorSource.slice(
      selectorSource.indexOf('sortedWarm = warmNodes.sort'),
      selectorSource.indexOf('for (const warmNode')
    );
    expect(warmSort).toContain('preferredSize &&');
    expect(warmSort).toContain('preferredLocation &&');
  });

  it('handles preferred location and size being undefined in capacity sort', () => {
    const capacitySort = selectorSource.slice(
      selectorSource.indexOf('Sort candidates'),
      selectorSource.indexOf('return candidates[0]')
    );
    expect(capacitySort).toContain('preferredLocation &&');
    expect(capacitySort).toContain('preferredSize &&');
  });

  it('function signature accepts optional preferredLocation and preferredSize', () => {
    expect(selectorSource).toContain('preferredLocation?: string');
    expect(selectorSource).toContain('preferredSize?: string');
  });

  it('function signature accepts optional taskId', () => {
    expect(selectorSource).toContain('taskId?: string');
  });
});

// =============================================================================
// Workspace count limit — behavioral + structural
// =============================================================================

describe('workspace count limit (MAX_WORKSPACES_PER_NODE)', () => {
  it('DEFAULT_MAX_WORKSPACES_PER_NODE is 3', () => {
    expect(DEFAULT_MAX_WORKSPACES_PER_NODE).toBe(3);
  });

  it('NodeSelectorEnv includes MAX_WORKSPACES_PER_NODE', () => {
    expect(selectorSource).toContain("MAX_WORKSPACES_PER_NODE?: string");
  });

  it('reads MAX_WORKSPACES_PER_NODE from env with fallback to default', () => {
    expect(selectorSource).toContain('env.MAX_WORKSPACES_PER_NODE');
    expect(selectorSource).toContain('DEFAULT_MAX_WORKSPACES_PER_NODE');
  });

  it('rejects nodes where activeCount >= maxWorkspacesPerNode before checking metrics', () => {
    const capacitySection = selectorSource.slice(
      selectorSource.indexOf('Get all running nodes')
    );
    // The workspace count check must appear before nodeHasCapacity
    const wsCheckIdx = capacitySection.indexOf('activeCount >= maxWorkspacesPerNode');
    const metricsCheckIdx = capacitySection.indexOf('nodeHasCapacity(');
    expect(wsCheckIdx).toBeGreaterThan(-1);
    expect(metricsCheckIdx).toBeGreaterThan(wsCheckIdx);
  });

  it('continues to next node when workspace count limit is reached', () => {
    // The workspace count check block includes a continue statement
    const wsCheckStart = selectorSource.indexOf('activeCount >= maxWorkspacesPerNode');
    // Get the next ~100 chars after the check to capture the continue
    const wsCheckBlock = selectorSource.slice(wsCheckStart, wsCheckStart + 100);
    expect(wsCheckBlock).toContain('continue');
  });
});

// =============================================================================
// TaskRunner workspace count limit consistency
// =============================================================================

const taskRunnerSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('TaskRunner findNodeWithCapacity workspace count limit', () => {
  it('imports DEFAULT_MAX_WORKSPACES_PER_NODE', () => {
    expect(taskRunnerSource).toContain('DEFAULT_MAX_WORKSPACES_PER_NODE');
  });

  it('reads MAX_WORKSPACES_PER_NODE from env', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('findNodeWithCapacity')
    );
    expect(section).toContain('MAX_WORKSPACES_PER_NODE');
  });

  it('queries workspace count per node and rejects at capacity', () => {
    const section = taskRunnerSource.slice(
      taskRunnerSource.indexOf('findNodeWithCapacity')
    );
    expect(section).toContain("status IN ('running', 'creating', 'recovery')");
    expect(section).toContain('>= maxWorkspaces');
  });
});
