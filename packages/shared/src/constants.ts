import type { VMSize, VMLocation } from './types';

// =============================================================================
// VM Size Configuration
// =============================================================================
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx23', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx33', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx43', cpus: 8, ram: '16GB' },
};

// =============================================================================
// VM Location Configuration
// =============================================================================
export const VM_LOCATIONS: Record<VMLocation, { name: string; country: string }> = {
  nbg1: { name: 'Nuremberg', country: 'DE' },
  fsn1: { name: 'Falkenstein', country: 'DE' },
  hel1: { name: 'Helsinki', country: 'FI' },
};

// =============================================================================
// Status Configuration
// =============================================================================
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  creating: 'Creating',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
};

export const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  creating: 'blue',
  running: 'green',
  stopping: 'yellow',
  stopped: 'gray',
  error: 'red',
};

// =============================================================================
// Defaults
// =============================================================================
export const DEFAULT_VM_SIZE: VMSize = 'medium';
export const DEFAULT_VM_LOCATION: VMLocation = 'nbg1';
export const DEFAULT_BRANCH = 'main';

// =============================================================================
// Default Limits (configurable via environment variables)
// Per constitution principle XI: all values must be configurable
// =============================================================================

/** Default max workspaces per user. Override via MAX_WORKSPACES_PER_USER env var. */
export const DEFAULT_MAX_WORKSPACES_PER_USER = 10;

/** Backwards compatibility alias - use DEFAULT_MAX_WORKSPACES_PER_USER */
export const MAX_WORKSPACES_PER_USER = DEFAULT_MAX_WORKSPACES_PER_USER;

/** Default max nodes per user. Override via MAX_NODES_PER_USER env var. */
export const DEFAULT_MAX_NODES_PER_USER = 10;

/** Default max workspaces per node. Override via MAX_WORKSPACES_PER_NODE env var. */
export const DEFAULT_MAX_WORKSPACES_PER_NODE = 10;

/** Default max agent sessions per workspace. Override via MAX_AGENT_SESSIONS_PER_WORKSPACE env var. */
export const DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE = 10;

/** Default node heartbeat staleness threshold in seconds. Override via NODE_HEARTBEAT_STALE_SECONDS env var. */
export const DEFAULT_NODE_HEARTBEAT_STALE_SECONDS = 180;

/** Default max projects per user. Override via MAX_PROJECTS_PER_USER env var. */
export const DEFAULT_MAX_PROJECTS_PER_USER = 25;

/** Default max tasks per project. Override via MAX_TASKS_PER_PROJECT env var. */
export const DEFAULT_MAX_TASKS_PER_PROJECT = 500;

/** Default max dependency edges per task. Override via MAX_TASK_DEPENDENCIES_PER_TASK env var. */
export const DEFAULT_MAX_TASK_DEPENDENCIES_PER_TASK = 25;

/** Default task list page size. Override via TASK_LIST_DEFAULT_PAGE_SIZE env var. */
export const DEFAULT_TASK_LIST_DEFAULT_PAGE_SIZE = 50;

/** Default max task list page size. Override via TASK_LIST_MAX_PAGE_SIZE env var. */
export const DEFAULT_TASK_LIST_MAX_PAGE_SIZE = 200;

/** Default callback timeout for delegated task updates in milliseconds. */
export const DEFAULT_TASK_CALLBACK_TIMEOUT_MS = 10000;

/** Default retry attempts for delegated task callback processing. */
export const DEFAULT_TASK_CALLBACK_RETRY_MAX_ATTEMPTS = 3;

/** Default idle timeout in seconds (30 minutes). Override via IDLE_TIMEOUT_SECONDS env var. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;

/** Default idle warning threshold (5 minutes before shutdown). */
export const DEFAULT_IDLE_WARNING_SECONDS = 25 * 60;

/** Maximum workspace name length. */
export const WORKSPACE_NAME_MAX_LENGTH = 64;

// =============================================================================
// Hetzner Configuration
// =============================================================================

/** Default Hetzner image. Override via HETZNER_IMAGE env var. */
export const DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04';

/** Backwards compatibility alias - use DEFAULT_HETZNER_IMAGE */
export const HETZNER_IMAGE = DEFAULT_HETZNER_IMAGE;

// Note: GitHub App install URL is NOT provided as a constant.
// It must be derived from the actual GitHub App configuration at runtime.
// Format: https://github.com/apps/{app-slug}/installations/new

// =============================================================================
// Agent Settings
// =============================================================================

/** Valid permission modes for agent sessions.
 * These match the mode IDs reported by claude-code-acp via ACP NewSession. */
export const VALID_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;

/** Human-readable labels for permission modes */
export const AGENT_PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass Permissions',
};

/** Human-readable descriptions for permission modes */
export const AGENT_PERMISSION_MODE_DESCRIPTIONS: Record<string, string> = {
  default: 'Standard behavior, prompts for dangerous operations',
  acceptEdits: 'Auto-accept file edit operations',
  plan: 'Planning mode, no actual tool execution',
  dontAsk: "Don't prompt for permissions, deny if not pre-approved",
  bypassPermissions: 'Bypass all permission checks',
};
