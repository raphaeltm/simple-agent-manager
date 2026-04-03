/**
 * Behavioral tests for configurable system limits.
 *
 * Tests the actual exported functions and constants instead of
 * reading source code as strings. Covers ALL 15 configurable limits
 * with both default values and env var overrides.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { getRuntimeLimits } from '../../../src/services/limits';

// =============================================================================
// getRuntimeLimits — behavioral tests for all 15 configurable limits
// =============================================================================

describe('getRuntimeLimits', () => {
  it('no longer returns maxWorkspacesPerNode', () => {
    const limits = getRuntimeLimits({});
    expect((limits as Record<string, unknown>).maxWorkspacesPerNode).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Default values for all 15 limits (no env overrides)
  // -------------------------------------------------------------------------

  describe('defaults (no env overrides)', () => {
    const defaults = getRuntimeLimits({});

    it('maxNodesPerUser defaults to 10', () => {
      expect(defaults.maxNodesPerUser).toBe(10);
    });

    it('maxAgentSessionsPerWorkspace defaults to 10', () => {
      expect(defaults.maxAgentSessionsPerWorkspace).toBe(10);
    });

    it('nodeHeartbeatStaleSeconds defaults to 180', () => {
      expect(defaults.nodeHeartbeatStaleSeconds).toBe(180);
    });

    it('maxProjectsPerUser defaults to 100', () => {
      expect(defaults.maxProjectsPerUser).toBe(100);
    });

    it('maxTasksPerProject defaults to 500', () => {
      expect(defaults.maxTasksPerProject).toBe(500);
    });

    it('maxTaskDependenciesPerTask defaults to 50', () => {
      expect(defaults.maxTaskDependenciesPerTask).toBe(50);
    });

    it('taskListDefaultPageSize defaults to 50', () => {
      expect(defaults.taskListDefaultPageSize).toBe(50);
    });

    it('taskListMaxPageSize defaults to 200', () => {
      expect(defaults.taskListMaxPageSize).toBe(200);
    });

    it('maxProjectRuntimeEnvVarsPerProject defaults to 150', () => {
      expect(defaults.maxProjectRuntimeEnvVarsPerProject).toBe(150);
    });

    it('maxProjectRuntimeFilesPerProject defaults to 50', () => {
      expect(defaults.maxProjectRuntimeFilesPerProject).toBe(50);
    });

    it('maxProjectRuntimeEnvValueBytes defaults to 8192', () => {
      expect(defaults.maxProjectRuntimeEnvValueBytes).toBe(8 * 1024);
    });

    it('maxProjectRuntimeFileContentBytes defaults to 131072', () => {
      expect(defaults.maxProjectRuntimeFileContentBytes).toBe(128 * 1024);
    });

    it('maxProjectRuntimeFilePathLength defaults to 256', () => {
      expect(defaults.maxProjectRuntimeFilePathLength).toBe(256);
    });

    it('taskCallbackTimeoutMs defaults to 10000', () => {
      expect(defaults.taskCallbackTimeoutMs).toBe(10000);
    });

    it('taskCallbackRetryMaxAttempts defaults to 3', () => {
      expect(defaults.taskCallbackRetryMaxAttempts).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Env var overrides for all 15 limits
  // -------------------------------------------------------------------------

  describe('env var overrides', () => {
    it('respects MAX_NODES_PER_USER', () => {
      expect(getRuntimeLimits({ MAX_NODES_PER_USER: '20' }).maxNodesPerUser).toBe(20);
    });

    it('respects MAX_AGENT_SESSIONS_PER_WORKSPACE', () => {
      expect(getRuntimeLimits({ MAX_AGENT_SESSIONS_PER_WORKSPACE: '5' }).maxAgentSessionsPerWorkspace).toBe(5);
    });

    it('respects NODE_HEARTBEAT_STALE_SECONDS', () => {
      expect(getRuntimeLimits({ NODE_HEARTBEAT_STALE_SECONDS: '300' }).nodeHeartbeatStaleSeconds).toBe(300);
    });

    it('respects MAX_PROJECTS_PER_USER', () => {
      expect(getRuntimeLimits({ MAX_PROJECTS_PER_USER: '200' }).maxProjectsPerUser).toBe(200);
    });

    it('respects MAX_TASKS_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_TASKS_PER_PROJECT: '1000' }).maxTasksPerProject).toBe(1000);
    });

    it('respects MAX_TASK_DEPENDENCIES_PER_TASK', () => {
      expect(getRuntimeLimits({ MAX_TASK_DEPENDENCIES_PER_TASK: '100' }).maxTaskDependenciesPerTask).toBe(100);
    });

    it('respects TASK_LIST_DEFAULT_PAGE_SIZE', () => {
      expect(getRuntimeLimits({ TASK_LIST_DEFAULT_PAGE_SIZE: '25' }).taskListDefaultPageSize).toBe(25);
    });

    it('respects TASK_LIST_MAX_PAGE_SIZE', () => {
      expect(getRuntimeLimits({ TASK_LIST_MAX_PAGE_SIZE: '500' }).taskListMaxPageSize).toBe(500);
    });

    it('respects MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT: '300' }).maxProjectRuntimeEnvVarsPerProject).toBe(300);
    });

    it('respects MAX_PROJECT_RUNTIME_FILES_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILES_PER_PROJECT: '100' }).maxProjectRuntimeFilesPerProject).toBe(100);
    });

    it('respects MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES: '16384' }).maxProjectRuntimeEnvValueBytes).toBe(16384);
    });

    it('respects MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES: '262144' }).maxProjectRuntimeFileContentBytes).toBe(262144);
    });

    it('respects MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH: '512' }).maxProjectRuntimeFilePathLength).toBe(512);
    });

    it('respects TASK_CALLBACK_TIMEOUT_MS', () => {
      expect(getRuntimeLimits({ TASK_CALLBACK_TIMEOUT_MS: '30000' }).taskCallbackTimeoutMs).toBe(30000);
    });

    it('respects TASK_CALLBACK_RETRY_MAX_ATTEMPTS', () => {
      expect(getRuntimeLimits({ TASK_CALLBACK_RETRY_MAX_ATTEMPTS: '5' }).taskCallbackRetryMaxAttempts).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid env values fall back to defaults
  // -------------------------------------------------------------------------

  describe('invalid env values use defaults', () => {
    it('ignores non-numeric string', () => {
      expect(getRuntimeLimits({ MAX_PROJECTS_PER_USER: 'not-a-number' }).maxProjectsPerUser).toBe(100);
    });

    it('ignores zero', () => {
      expect(getRuntimeLimits({ MAX_NODES_PER_USER: '0' }).maxNodesPerUser).toBe(10);
    });

    it('ignores negative numbers', () => {
      expect(getRuntimeLimits({ MAX_TASKS_PER_PROJECT: '-5' }).maxTasksPerProject).toBe(500);
    });

    it('ignores empty string', () => {
      expect(getRuntimeLimits({ NODE_HEARTBEAT_STALE_SECONDS: '' }).nodeHeartbeatStaleSeconds).toBe(180);
    });
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
