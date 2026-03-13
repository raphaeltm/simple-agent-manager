import type { VMSize, VMLocation, WorkspaceProfile } from './types';

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
export const DEFAULT_WORKSPACE_PROFILE: WorkspaceProfile = 'full';
export const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];

// =============================================================================
// Default Limits (configurable via environment variables)
// Per constitution principle XI: all values must be configurable
// =============================================================================

/** Default max nodes per user. Override via MAX_NODES_PER_USER env var. */
export const DEFAULT_MAX_NODES_PER_USER = 10;

/** Default max workspaces per node. Override via MAX_WORKSPACES_PER_NODE env var. */
export const DEFAULT_MAX_WORKSPACES_PER_NODE = 3;

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

// =============================================================================
// Task Run Defaults (Autonomous Execution)
// =============================================================================

/** Default CPU usage threshold (%) above which a node is considered full. Override via TASK_RUN_NODE_CPU_THRESHOLD_PERCENT env var. */
export const DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT = 50;

/** Default memory usage threshold (%) above which a node is considered full. Override via TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT env var. */
export const DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT = 50;

/** Default delay (ms) after task completion before cleanup. Override via TASK_RUN_CLEANUP_DELAY_MS env var. */
export const DEFAULT_TASK_RUN_CLEANUP_DELAY_MS = 5000;


// =============================================================================
// Warm Node Pooling
// =============================================================================

/** Default warm timeout (ms) before an idle node is destroyed. Override via NODE_WARM_TIMEOUT_MS env var. */
export const DEFAULT_NODE_WARM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Default maximum lifetime (ms) for an auto-provisioned node. Override via MAX_AUTO_NODE_LIFETIME_MS env var. */
export const DEFAULT_MAX_AUTO_NODE_LIFETIME_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Absolute maximum lifetime (ms) for an auto-provisioned node — hard safety ceiling.
 * Destroys nodes regardless of active workspaces to prevent unbounded cost.
 * Override via ABSOLUTE_MAX_NODE_LIFETIME_MS env var. */
export const DEFAULT_ABSOLUTE_MAX_NODE_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Default grace period (ms) for cron sweep stale detection. Override via NODE_WARM_GRACE_PERIOD_MS env var. */
export const DEFAULT_NODE_WARM_GRACE_PERIOD_MS = 35 * 60 * 1000; // 35 minutes (warm timeout + 5 min buffer)

/** Default alarm retry delay (ms) when node destruction fails. */
export const DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS = 60 * 1000; // 1 minute

// =============================================================================
// Task Execution Timeout (Stuck Task Recovery)
// =============================================================================

/** Default max execution time (ms) for a task before it's considered stuck. Override via TASK_RUN_MAX_EXECUTION_MS env var. */
export const DEFAULT_TASK_RUN_MAX_EXECUTION_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Default threshold (ms) for a task stuck in 'queued' status. Override via TASK_STUCK_QUEUED_TIMEOUT_MS env var.
 * Must be >= node provisioning time + agent ready timeout (~3-4 min) to avoid false positives.
 * Set to 10 minutes to account for cold-start node provisioning + agent bootstrap. */
export const DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Default threshold (ms) for a task stuck in 'delegated' status. Override via TASK_STUCK_DELEGATED_TIMEOUT_MS env var.
 * Must be > TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS (30 min) to avoid stuck-task recovery killing legitimate workspace startups.
 * Set to 31 minutes (1 min buffer above workspace ready timeout). */
export const DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS = 31 * 60 * 1000; // 31 minutes

// =============================================================================
// TaskRunner DO Defaults (Alarm-Driven Orchestration — TDF-2)
// =============================================================================

/** Default max retries per step before failing the task. Override via TASK_RUNNER_STEP_MAX_RETRIES env var. */
export const DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES = 3;

/** Default base delay (ms) for retry backoff. Override via TASK_RUNNER_RETRY_BASE_DELAY_MS env var. */
export const DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS = 5_000;

/** Default max delay (ms) for retry backoff. Override via TASK_RUNNER_RETRY_MAX_DELAY_MS env var. */
export const DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS = 60_000;

/** Default health check poll interval (ms) for agent readiness. Override via TASK_RUNNER_AGENT_POLL_INTERVAL_MS env var. */
export const DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS = 5_000;

/**
 * Default timeout (ms) for VM agent to become healthy after node provisioning.
 * Fresh VMs need cloud-init to complete (install Docker, pull images, start agent),
 * which typically takes 3-5 minutes. Aligned with DEFAULT_NODE_AGENT_READY_TIMEOUT_MS
 * in node-agent.ts to avoid divergent timeout behavior between code paths.
 * Override via TASK_RUNNER_AGENT_READY_TIMEOUT_MS env var.
 */
export const DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS = 600_000;

/** Default timeout (ms) for workspace-ready callback. Override via TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS env var. */
export const DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Default poll interval (ms) for provisioning status checks. Override via TASK_RUNNER_PROVISION_POLL_INTERVAL_MS env var. */
export const DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS = 10_000;

// =============================================================================
// Hetzner Configuration
// =============================================================================

/** Threshold (ms) after which a task is considered inactive on the dashboard. Override via DASHBOARD_INACTIVE_THRESHOLD_MS. */
export const DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Default dashboard poll interval (ms) for active tasks. */
export const DEFAULT_DASHBOARD_POLL_INTERVAL_MS = 15_000; // 15 seconds

/** Default Hetzner image. Override via HETZNER_IMAGE env var. */
export const DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04';

/** Backwards compatibility alias - use DEFAULT_HETZNER_IMAGE */
export const HETZNER_IMAGE = DEFAULT_HETZNER_IMAGE;

/** Default Scaleway zone. Override via SCALEWAY_ZONE env var. */
export const DEFAULT_SCALEWAY_ZONE = 'fr-par-1';

/** Default Scaleway image name for label-based lookup. Override via SCALEWAY_IMAGE_NAME env var. */
export const DEFAULT_SCALEWAY_IMAGE_NAME = 'ubuntu_noble';

// Note: GitHub App install URL is NOT provided as a constant.
// It must be derived from the actual GitHub App configuration at runtime.
// Format: https://github.com/apps/{app-slug}/installations/new

// =============================================================================
// AI Task Title Generation
// =============================================================================

/** Default Workers AI model for task title generation. Override via TASK_TITLE_MODEL env var. */
export const DEFAULT_TASK_TITLE_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max generated title length. Override via TASK_TITLE_MAX_LENGTH env var. */
export const DEFAULT_TASK_TITLE_MAX_LENGTH = 100;

/** Default timeout (ms) for AI title generation. Override via TASK_TITLE_TIMEOUT_MS env var. */
export const DEFAULT_TASK_TITLE_TIMEOUT_MS = 5000;

/** Default short-message threshold for AI title generation (messages at or below this length are used as-is).
 * Override via TASK_TITLE_SHORT_MESSAGE_THRESHOLD env var. */
export const DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD = 100;

/** Default max retry attempts for AI title generation. Override via TASK_TITLE_MAX_RETRIES env var. */
export const DEFAULT_TASK_TITLE_MAX_RETRIES = 2;

/** Default base delay (ms) between retry attempts (exponential backoff). Override via TASK_TITLE_RETRY_DELAY_MS env var. */
export const DEFAULT_TASK_TITLE_RETRY_DELAY_MS = 1000;

/** Default max delay (ms) cap for retry backoff. Override via TASK_TITLE_RETRY_MAX_DELAY_MS env var. */
export const DEFAULT_TASK_TITLE_RETRY_MAX_DELAY_MS = 4000;

// =============================================================================
// Agent Settings
// =============================================================================

/** Valid permission modes for agent sessions.
 * These match the mode IDs reported by claude-agent-acp via ACP NewSession. */
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
