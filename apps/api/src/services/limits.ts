import {
  DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE,
  DEFAULT_MAX_NODES_PER_USER,
  DEFAULT_MAX_PROJECTS_PER_USER,
  DEFAULT_MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES,
  DEFAULT_MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT,
  DEFAULT_MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES,
  DEFAULT_MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH,
  DEFAULT_MAX_PROJECT_RUNTIME_FILES_PER_PROJECT,
  DEFAULT_MAX_TASK_DEPENDENCIES_PER_TASK,
  DEFAULT_MAX_TASKS_PER_PROJECT,
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_MAX_WORKSPACES_PER_USER,
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_CALLBACK_RETRY_MAX_ATTEMPTS,
  DEFAULT_TASK_CALLBACK_TIMEOUT_MS,
  DEFAULT_TASK_LIST_DEFAULT_PAGE_SIZE,
  DEFAULT_TASK_LIST_MAX_PAGE_SIZE,
} from '@simple-agent-manager/shared';

export interface RuntimeLimits {
  maxNodesPerUser: number;
  maxWorkspacesPerUser: number;
  maxWorkspacesPerNode: number;
  maxAgentSessionsPerWorkspace: number;
  nodeHeartbeatStaleSeconds: number;
  maxProjectsPerUser: number;
  maxTasksPerProject: number;
  maxTaskDependenciesPerTask: number;
  taskListDefaultPageSize: number;
  taskListMaxPageSize: number;
  maxProjectRuntimeEnvVarsPerProject: number;
  maxProjectRuntimeFilesPerProject: number;
  maxProjectRuntimeEnvValueBytes: number;
  maxProjectRuntimeFileContentBytes: number;
  maxProjectRuntimeFilePathLength: number;
  taskCallbackTimeoutMs: number;
  taskCallbackRetryMaxAttempts: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getRuntimeLimits(env: {
  MAX_NODES_PER_USER?: string;
  MAX_WORKSPACES_PER_USER?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_AGENT_SESSIONS_PER_WORKSPACE?: string;
  NODE_HEARTBEAT_STALE_SECONDS?: string;
  MAX_PROJECTS_PER_USER?: string;
  MAX_TASKS_PER_PROJECT?: string;
  MAX_TASK_DEPENDENCIES_PER_TASK?: string;
  TASK_LIST_DEFAULT_PAGE_SIZE?: string;
  TASK_LIST_MAX_PAGE_SIZE?: string;
  MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_FILES_PER_PROJECT?: string;
  MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES?: string;
  MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH?: string;
  TASK_CALLBACK_TIMEOUT_MS?: string;
  TASK_CALLBACK_RETRY_MAX_ATTEMPTS?: string;
}): RuntimeLimits {
  return {
    maxNodesPerUser: parsePositiveInt(env.MAX_NODES_PER_USER, DEFAULT_MAX_NODES_PER_USER),
    maxWorkspacesPerUser: parsePositiveInt(env.MAX_WORKSPACES_PER_USER, DEFAULT_MAX_WORKSPACES_PER_USER),
    maxWorkspacesPerNode: parsePositiveInt(env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE),
    maxAgentSessionsPerWorkspace: parsePositiveInt(
      env.MAX_AGENT_SESSIONS_PER_WORKSPACE,
      DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE
    ),
    nodeHeartbeatStaleSeconds: parsePositiveInt(
      env.NODE_HEARTBEAT_STALE_SECONDS,
      DEFAULT_NODE_HEARTBEAT_STALE_SECONDS
    ),
    maxProjectsPerUser: parsePositiveInt(env.MAX_PROJECTS_PER_USER, DEFAULT_MAX_PROJECTS_PER_USER),
    maxTasksPerProject: parsePositiveInt(env.MAX_TASKS_PER_PROJECT, DEFAULT_MAX_TASKS_PER_PROJECT),
    maxTaskDependenciesPerTask: parsePositiveInt(
      env.MAX_TASK_DEPENDENCIES_PER_TASK,
      DEFAULT_MAX_TASK_DEPENDENCIES_PER_TASK
    ),
    taskListDefaultPageSize: parsePositiveInt(
      env.TASK_LIST_DEFAULT_PAGE_SIZE,
      DEFAULT_TASK_LIST_DEFAULT_PAGE_SIZE
    ),
    taskListMaxPageSize: parsePositiveInt(
      env.TASK_LIST_MAX_PAGE_SIZE,
      DEFAULT_TASK_LIST_MAX_PAGE_SIZE
    ),
    maxProjectRuntimeEnvVarsPerProject: parsePositiveInt(
      env.MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT,
      DEFAULT_MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT
    ),
    maxProjectRuntimeFilesPerProject: parsePositiveInt(
      env.MAX_PROJECT_RUNTIME_FILES_PER_PROJECT,
      DEFAULT_MAX_PROJECT_RUNTIME_FILES_PER_PROJECT
    ),
    maxProjectRuntimeEnvValueBytes: parsePositiveInt(
      env.MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES,
      DEFAULT_MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES
    ),
    maxProjectRuntimeFileContentBytes: parsePositiveInt(
      env.MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES,
      DEFAULT_MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES
    ),
    maxProjectRuntimeFilePathLength: parsePositiveInt(
      env.MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH,
      DEFAULT_MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH
    ),
    taskCallbackTimeoutMs: parsePositiveInt(
      env.TASK_CALLBACK_TIMEOUT_MS,
      DEFAULT_TASK_CALLBACK_TIMEOUT_MS
    ),
    taskCallbackRetryMaxAttempts: parsePositiveInt(
      env.TASK_CALLBACK_RETRY_MAX_ATTEMPTS,
      DEFAULT_TASK_CALLBACK_RETRY_MAX_ATTEMPTS
    ),
  };
}
