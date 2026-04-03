/**
 * Behavioral tests for configurable system limits.
 *
 * Tests the actual exported functions and constants instead of
 * reading source code as strings.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { getRuntimeLimits } from '../../../src/services/limits';

// =============================================================================
// getRuntimeLimits — behavioral tests
// =============================================================================

describe('getRuntimeLimits', () => {
  it('no longer returns maxWorkspacesPerNode', () => {
    const limits = getRuntimeLimits({});
    expect((limits as Record<string, unknown>).maxWorkspacesPerNode).toBeUndefined();
  });

  it('returns maxProjectsPerUser default of 100', () => {
    expect(getRuntimeLimits({}).maxProjectsPerUser).toBe(100);
  });

  it('returns maxTaskDependenciesPerTask default of 50', () => {
    expect(getRuntimeLimits({}).maxTaskDependenciesPerTask).toBe(50);
  });

  it('respects MAX_PROJECTS_PER_USER env override', () => {
    const limits = getRuntimeLimits({ MAX_PROJECTS_PER_USER: '200' });
    expect(limits.maxProjectsPerUser).toBe(200);
  });

  it('respects MAX_TASK_DEPENDENCIES_PER_TASK env override', () => {
    const limits = getRuntimeLimits({ MAX_TASK_DEPENDENCIES_PER_TASK: '100' });
    expect(limits.maxTaskDependenciesPerTask).toBe(100);
  });

  it('ignores invalid env values and uses defaults', () => {
    const limits = getRuntimeLimits({ MAX_PROJECTS_PER_USER: 'not-a-number' });
    expect(limits.maxProjectsPerUser).toBe(100);
  });
});

// =============================================================================
// DEFAULT_RATE_LIMITS — value assertions
// =============================================================================

describe('DEFAULT_RATE_LIMITS', () => {
  it('WORKSPACE_CREATE is 30', () => {
    expect(DEFAULT_RATE_LIMITS.WORKSPACE_CREATE).toBe(30);
  });

  it('CREDENTIAL_UPDATE is 30', () => {
    expect(DEFAULT_RATE_LIMITS.CREDENTIAL_UPDATE).toBe(30);
  });

  it('TERMINAL_TOKEN is 60', () => {
    expect(DEFAULT_RATE_LIMITS.TERMINAL_TOKEN).toBe(60);
  });

  it('ANONYMOUS is 100', () => {
    expect(DEFAULT_RATE_LIMITS.ANONYMOUS).toBe(100);
  });

  it('CLIENT_ERRORS is 200', () => {
    expect(DEFAULT_RATE_LIMITS.CLIENT_ERRORS).toBe(200);
  });
});
