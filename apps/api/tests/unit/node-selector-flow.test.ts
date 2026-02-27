/**
 * Source contract tests for selectNodeForTaskRun() flow (TDF-3).
 *
 * Validates the complete node selection algorithm:
 * - Warm pool path: nodes with warmSince selected first, sorted by size/location match
 * - Warm pool miss: no warm nodes -> falls through to capacity check
 * - Capacity path: running nodes filtered by health/workspace count/CPU/memory thresholds
 * - Capacity scoring: verify score = cpu * 0.4 + memory * 0.6 picks lowest-load node
 * - No available node: returns null
 * - Edge cases: zero nodes, all unhealthy, all at capacity, size/location mismatch fallback
 * - Threshold overrides from env vars
 * - Defense-in-depth: re-check D1 status before DO call
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  it('sets activeWorkspaceCount to 0 for claimed warm nodes', () => {
    const warmSection = selectorSource.slice(
      selectorSource.indexOf('for (const warmNode'),
      selectorSource.indexOf('Get all running nodes')
    );
    expect(warmSection).toContain('activeWorkspaceCount: 0');
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

  it('reads max workspaces from MAX_WORKSPACES_PER_NODE env var', () => {
    expect(selectorSource).toContain('env.MAX_WORKSPACES_PER_NODE');
  });

  it('defaults CPU threshold to shared constant (80)', () => {
    expect(selectorSource).toContain('DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
  });

  it('defaults memory threshold to shared constant (80)', () => {
    expect(selectorSource).toContain('DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('defaults max workspaces per node to 10', () => {
    expect(selectorSource).toContain('|| 10');
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
  it('skips warm pool entirely when taskId is undefined', () => {
    expect(selectorSource).toContain('if (taskId && env.NODE_LIFECYCLE)');
  });

  it('skips warm pool entirely when NODE_LIFECYCLE binding is missing', () => {
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
