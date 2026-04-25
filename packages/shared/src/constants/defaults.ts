import type { VMSize, WorkspaceProfile } from '../types';

// =============================================================================
// Defaults
// =============================================================================
export const DEFAULT_VM_SIZE: VMSize = 'medium';
/** Default VM location (Hetzner). Provider-specific defaults come from the provider catalog. */
export const DEFAULT_VM_LOCATION = 'nbg1';
export const DEFAULT_BRANCH = 'main';
export const DEFAULT_WORKSPACE_PROFILE: WorkspaceProfile = 'full';
export const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];

/**
 * Regex for valid devcontainer config names (directory names under .devcontainer/).
 * Allows alphanumeric characters, hyphens, and underscores.
 * Override via DEVCONTAINER_CONFIG_NAME_PATTERN env var.
 */
export const DEVCONTAINER_CONFIG_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Maximum length for devcontainer config names. Override via DEVCONTAINER_CONFIG_NAME_MAX_LENGTH env var. */
export const DEVCONTAINER_CONFIG_NAME_MAX_LENGTH = 128;

// =============================================================================
// Default Limits (configurable via environment variables)
// Per constitution principle XI: all values must be configurable
// =============================================================================

/** Default max nodes per user. Override via MAX_NODES_PER_USER env var. */
export const DEFAULT_MAX_NODES_PER_USER = 10;

/** Default max agent sessions per workspace. Override via MAX_AGENT_SESSIONS_PER_WORKSPACE env var. */
export const DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE = 10;

/** Default node heartbeat staleness threshold in seconds. Override via NODE_HEARTBEAT_STALE_SECONDS env var. */
export const DEFAULT_NODE_HEARTBEAT_STALE_SECONDS = 180;

/** Default max projects per user. Override via MAX_PROJECTS_PER_USER env var. */
export const DEFAULT_MAX_PROJECTS_PER_USER = 100;

/** Default max tasks per project. Override via MAX_TASKS_PER_PROJECT env var. */
export const DEFAULT_MAX_TASKS_PER_PROJECT = 10_000;

/** Default max dependency edges per task. Override via MAX_TASK_DEPENDENCIES_PER_TASK env var. */
export const DEFAULT_MAX_TASK_DEPENDENCIES_PER_TASK = 50;

/** Default task list page size. Override via TASK_LIST_DEFAULT_PAGE_SIZE env var. */
export const DEFAULT_TASK_LIST_DEFAULT_PAGE_SIZE = 50;

/** Default max task list page size. Override via TASK_LIST_MAX_PAGE_SIZE env var. */
export const DEFAULT_TASK_LIST_MAX_PAGE_SIZE = 200;

/** Default callback timeout for delegated task updates in milliseconds. */
export const DEFAULT_TASK_CALLBACK_TIMEOUT_MS = 10000;

/** Default retry attempts for delegated task callback processing. */
export const DEFAULT_TASK_CALLBACK_RETRY_MAX_ATTEMPTS = 3;

/** Default max runtime env vars per project. Override via MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT env var. */
export const DEFAULT_MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT = 150;

/** Default max runtime files per project. Override via MAX_PROJECT_RUNTIME_FILES_PER_PROJECT env var. */
export const DEFAULT_MAX_PROJECT_RUNTIME_FILES_PER_PROJECT = 50;

/** Default max runtime env var value size in bytes. Override via MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES env var. */
export const DEFAULT_MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES = 8 * 1024;

/** Default max runtime file content size in bytes. Override via MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES env var. */
export const DEFAULT_MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES = 128 * 1024;

/** Default max runtime file path length. Override via MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH env var. */
export const DEFAULT_MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH = 256;

/** Maximum workspace name length. */
export const WORKSPACE_NAME_MAX_LENGTH = 64;

/** Threshold (ms) after which a task is considered inactive on the dashboard. Override via DASHBOARD_INACTIVE_THRESHOLD_MS. */
export const DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Default dashboard poll interval (ms) for active tasks. */
export const DEFAULT_DASHBOARD_POLL_INTERVAL_MS = 15_000; // 15 seconds

// =============================================================================
// MCP Token Configuration
// =============================================================================

/** Default MCP token TTL in seconds. Must be >= DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000
 * so tokens remain valid for the full duration of a task. Override via MCP_TOKEN_TTL_SECONDS env var. */
export const DEFAULT_MCP_TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours (aligned with task max execution time)

/** Default MCP token max lifetime in seconds. Override via MCP_TOKEN_MAX_LIFETIME_SECONDS env var. */
export const DEFAULT_MCP_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60; // 24 hours hard cap for sliding-window refresh
