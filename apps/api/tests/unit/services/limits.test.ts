import { describe, expect, it } from 'vitest';
import { getRuntimeLimits } from '../../../src/services/limits';

describe('getRuntimeLimits', () => {
  it('parses project and task limits with defaults', () => {
    const defaults = getRuntimeLimits({});
    expect(defaults.maxProjectsPerUser).toBe(25);
    expect(defaults.maxTasksPerProject).toBe(500);
    expect(defaults.maxTaskDependenciesPerTask).toBe(25);
    expect(defaults.taskListDefaultPageSize).toBe(50);
    expect(defaults.taskListMaxPageSize).toBe(200);
    expect(defaults.maxProjectRuntimeEnvVarsPerProject).toBe(150);
    expect(defaults.maxProjectRuntimeFilesPerProject).toBe(50);
    expect(defaults.maxProjectRuntimeEnvValueBytes).toBe(8192);
    expect(defaults.maxProjectRuntimeFileContentBytes).toBe(131072);
    expect(defaults.maxProjectRuntimeFilePathLength).toBe(256);
    expect(defaults.taskCallbackTimeoutMs).toBe(10000);
    expect(defaults.taskCallbackRetryMaxAttempts).toBe(3);
  });

  it('uses valid env overrides and falls back on invalid values', () => {
    const parsed = getRuntimeLimits({
      MAX_PROJECTS_PER_USER: '40',
      MAX_TASKS_PER_PROJECT: '1000',
      MAX_TASK_DEPENDENCIES_PER_TASK: '12',
      TASK_LIST_DEFAULT_PAGE_SIZE: '75',
      TASK_LIST_MAX_PAGE_SIZE: '500',
      MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT: '80',
      MAX_PROJECT_RUNTIME_FILES_PER_PROJECT: '20',
      MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES: '4096',
      MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES: '65536',
      MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH: '-1',
      TASK_CALLBACK_TIMEOUT_MS: '15000',
      TASK_CALLBACK_RETRY_MAX_ATTEMPTS: '-1',
    });

    expect(parsed.maxProjectsPerUser).toBe(40);
    expect(parsed.maxTasksPerProject).toBe(1000);
    expect(parsed.maxTaskDependenciesPerTask).toBe(12);
    expect(parsed.taskListDefaultPageSize).toBe(75);
    expect(parsed.taskListMaxPageSize).toBe(500);
    expect(parsed.maxProjectRuntimeEnvVarsPerProject).toBe(80);
    expect(parsed.maxProjectRuntimeFilesPerProject).toBe(20);
    expect(parsed.maxProjectRuntimeEnvValueBytes).toBe(4096);
    expect(parsed.maxProjectRuntimeFileContentBytes).toBe(65536);
    expect(parsed.maxProjectRuntimeFilePathLength).toBe(256);
    expect(parsed.taskCallbackTimeoutMs).toBe(15000);
    expect(parsed.taskCallbackRetryMaxAttempts).toBe(3);
  });
});
