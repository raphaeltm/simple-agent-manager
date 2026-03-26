import type { VMSize, WorkspaceProfile } from './types';

// =============================================================================
// VM Size Display (provider-agnostic)
// =============================================================================

/** Generic VM size display info. For provider-specific details (exact specs, price),
 *  use the provider catalog API (GET /api/providers/catalog). */
export const VM_SIZE_LABELS: Record<VMSize, { label: string; shortDescription: string }> = {
  small: { label: 'Small', shortDescription: '2-3 vCPUs, 4 GB RAM' },
  medium: { label: 'Medium', shortDescription: '4 vCPUs, 8-12 GB RAM' },
  large: { label: 'Large', shortDescription: '8 vCPUs, 16-32 GB RAM' },
};

/**
 * @deprecated Use VM_SIZE_LABELS for display and provider catalog for specs.
 * Kept for backward compatibility with existing node display components.
 */
export const VM_SIZE_CONFIG: Record<VMSize, { hetznerType: string; cpus: number; ram: string }> = {
  small: { hetznerType: 'cx23', cpus: 2, ram: '4GB' },
  medium: { hetznerType: 'cx33', cpus: 4, ram: '8GB' },
  large: { hetznerType: 'cx43', cpus: 8, ram: '16GB' },
};

// =============================================================================
// Provider Display Labels
// =============================================================================

/** Human-readable display labels for credential providers. */
export const PROVIDER_LABELS: Record<string, string> = {
  hetzner: 'Hetzner',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud',
};

// =============================================================================
// VM Location Display Names (all providers)
// =============================================================================
export const VM_LOCATIONS: Record<string, { name: string; country: string }> = {
  // Hetzner
  nbg1: { name: 'Nuremberg', country: 'DE' },
  fsn1: { name: 'Falkenstein', country: 'DE' },
  hel1: { name: 'Helsinki', country: 'FI' },
  ash: { name: 'Ashburn', country: 'US' },
  hil: { name: 'Hillsboro', country: 'US' },
  // Scaleway
  'fr-par-1': { name: 'Paris 1', country: 'FR' },
  'fr-par-2': { name: 'Paris 2', country: 'FR' },
  'fr-par-3': { name: 'Paris 3', country: 'FR' },
  'nl-ams-1': { name: 'Amsterdam 1', country: 'NL' },
  'nl-ams-2': { name: 'Amsterdam 2', country: 'NL' },
  'nl-ams-3': { name: 'Amsterdam 3', country: 'NL' },
  'pl-waw-1': { name: 'Warsaw 1', country: 'PL' },
  'pl-waw-2': { name: 'Warsaw 2', country: 'PL' },
  // GCP
  'us-central1-a': { name: 'Iowa', country: 'US' },
  'us-east1-b': { name: 'South Carolina', country: 'US' },
  'us-west1-a': { name: 'Oregon', country: 'US' },
  'europe-west1-b': { name: 'Belgium', country: 'BE' },
  'europe-west3-a': { name: 'Frankfurt', country: 'DE' },
  'europe-west2-a': { name: 'London', country: 'GB' },
  'asia-southeast1-a': { name: 'Singapore', country: 'SG' },
  'asia-northeast1-a': { name: 'Tokyo', country: 'JP' },
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
/** Default VM location (Hetzner). Provider-specific defaults come from the provider catalog. */
export const DEFAULT_VM_LOCATION = 'nbg1';
export const DEFAULT_BRANCH = 'main';
export const DEFAULT_WORKSPACE_PROFILE: WorkspaceProfile = 'full';
export const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];

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
export const DEFAULT_MAX_TASKS_PER_PROJECT = 500;

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

// =============================================================================
// Task Run Defaults (Autonomous Execution)
// =============================================================================

/** Default max workspaces per node. Hard ceiling regardless of CPU/memory metrics.
 * Override via MAX_WORKSPACES_PER_NODE env var. */
export const DEFAULT_MAX_WORKSPACES_PER_NODE = 3;

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

/** Default grace period (ms) for cron sweep stale detection. Override via NODE_WARM_GRACE_PERIOD_MS env var. */
export const DEFAULT_NODE_WARM_GRACE_PERIOD_MS = 35 * 60 * 1000; // 35 minutes (warm timeout + 5 min buffer)

/** Default grace period (ms) before stopping orphaned task workspaces. Override via ORPHANED_WORKSPACE_GRACE_PERIOD_MS env var. */
export const DEFAULT_ORPHANED_WORKSPACE_GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

/** Default alarm retry delay (ms) when node destruction fails. */
export const DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS = 60 * 1000; // 1 minute

// =============================================================================
// Workspace Idle Timeout (Compute Lifecycle Management)
// =============================================================================

/** Default workspace idle timeout (ms). Workspaces with no messages AND no terminal activity
 * for this duration are auto-deleted. Override per-project via project settings or via
 * WORKSPACE_IDLE_TIMEOUT_MS env var. */
export const DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Minimum workspace idle timeout (ms). */
export const MIN_WORKSPACE_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum workspace idle timeout (ms). */
export const MAX_WORKSPACE_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Minimum node idle timeout (ms). */
export const MIN_NODE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum node idle timeout (ms). */
export const MAX_NODE_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Interval (ms) at which the ProjectData DO checks workspace idle state. */
export const WORKSPACE_IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum interval (ms) between terminal activity updates to the DO to avoid write amplification.
 * Intended for frontend heartbeat interval — not yet enforced server-side. */
export const TERMINAL_ACTIVITY_THROTTLE_MS = 60 * 1000; // 1 minute

// =============================================================================
// MCP Token Configuration
// =============================================================================

/** Default MCP token TTL in seconds. Must be >= DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000
 * so tokens remain valid for the full duration of a task. Override via MCP_TOKEN_TTL_SECONDS env var. */
export const DEFAULT_MCP_TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours (aligned with task max execution time)

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

/**
 * Default poll interval (ms) for checking workspace status in D1 during the
 * workspace_ready step. The primary advancement mechanism is the VM agent
 * callback, but periodic polling catches cases where the callback succeeds
 * (updating D1) but the DO notification fails, or where the VM agent retries
 * the callback via heartbeat after initial failures. Override via
 * TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS env var.
 */
export const DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS = 30_000; // 30 seconds

/** Default poll interval (ms) for provisioning status checks. Override via TASK_RUNNER_PROVISION_POLL_INTERVAL_MS env var. */
export const DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS = 10_000;

// =============================================================================
// Hetzner Configuration
// =============================================================================

/** Threshold (ms) after which a task is considered inactive on the dashboard. Override via DASHBOARD_INACTIVE_THRESHOLD_MS. */
export const DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/** Default dashboard poll interval (ms) for active tasks. */
export const DEFAULT_DASHBOARD_POLL_INTERVAL_MS = 15_000; // 15 seconds

/** Default Hetzner datacenter. Override via HETZNER_DATACENTER env var. */
export const DEFAULT_HETZNER_DATACENTER = 'fsn1';

/** Default Hetzner image. Override via HETZNER_IMAGE env var. */
export const DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04';

/** Backwards compatibility alias - use DEFAULT_HETZNER_IMAGE */
export const HETZNER_IMAGE = DEFAULT_HETZNER_IMAGE;

/** Default Scaleway zone. Override via SCALEWAY_ZONE env var. */
export const DEFAULT_SCALEWAY_ZONE = 'fr-par-1';

/** Default Scaleway image name for label-based lookup. Override via SCALEWAY_IMAGE_NAME env var. */
export const DEFAULT_SCALEWAY_IMAGE_NAME = 'ubuntu_noble';

/** Default GCP zone. Override via GCP_DEFAULT_ZONE env var. */
export const DEFAULT_GCP_ZONE = 'us-central1-a';

/** Default GCP image family. Override via GCP_IMAGE_FAMILY env var. */
export const DEFAULT_GCP_IMAGE_FAMILY = 'ubuntu-2404-lts-amd64';

/** Default GCP image project. Override via GCP_IMAGE_PROJECT env var. */
export const DEFAULT_GCP_IMAGE_PROJECT = 'ubuntu-os-cloud';

/** Default GCP disk size in GB. Override via GCP_DISK_SIZE_GB env var. */
export const DEFAULT_GCP_DISK_SIZE_GB = 50;

/** Default GCP WIF pool ID. Override via GCP_WIF_POOL_ID env var. */
export const DEFAULT_GCP_WIF_POOL_ID = 'sam-pool';

/** Default GCP WIF provider ID. Override via GCP_WIF_PROVIDER_ID env var. */
export const DEFAULT_GCP_WIF_PROVIDER_ID = 'sam-oidc';

/** Default GCP service account ID. Override via GCP_SERVICE_ACCOUNT_ID env var. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_ID = 'sam-vm-manager';

/** Default GCP STS token cache TTL in seconds (55 minutes). Override via GCP_TOKEN_CACHE_TTL_SECONDS env var. */
export const DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS = 55 * 60;

/** Default GCP identity token expiry in seconds (10 minutes). Override via GCP_IDENTITY_TOKEN_EXPIRY_SECONDS env var. */
export const DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS = 600;

/** Default GCP operation poll timeout in ms (5 minutes). Override via GCP_OPERATION_POLL_TIMEOUT_MS env var. */
export const DEFAULT_GCP_OPERATION_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default GCP API timeout in ms (30 seconds). Override via GCP_API_TIMEOUT_MS env var. */
export const DEFAULT_GCP_API_TIMEOUT_MS = 30_000;

/** Default GCP SA access token lifetime in seconds (1 hour). Override via GCP_SA_TOKEN_LIFETIME_SECONDS env var. */
export const DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS = 3600;

/** Default scope for GCP STS token exchange. Override via GCP_STS_SCOPE env var. */
export const DEFAULT_GCP_STS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Default scopes for GCP SA impersonation (comma-separated). Override via GCP_SA_IMPERSONATION_SCOPES env var. */
export const DEFAULT_GCP_SA_IMPERSONATION_SCOPES = 'https://www.googleapis.com/auth/compute';


// =============================================================================
// GCP Deployment (project-level OIDC for Defang)
// =============================================================================

/** Default WIF pool ID for deployment. Override via GCP_DEPLOY_WIF_POOL_ID env var. */
export const DEFAULT_GCP_DEPLOY_WIF_POOL_ID = 'sam-deploy-pool';

/** Default WIF provider ID for deployment. Override via GCP_DEPLOY_WIF_PROVIDER_ID env var. */
export const DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID = 'sam-oidc';

/** Default service account ID for deployment. Override via GCP_DEPLOY_SERVICE_ACCOUNT_ID env var. */
export const DEFAULT_GCP_DEPLOY_SERVICE_ACCOUNT_ID = 'sam-deployer';

/** Default identity token expiry for deployment (10 minutes). Override via GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS = 600;

/** Default GCP STS token URL. Override via GCP_STS_TOKEN_URL env var. */
export const DEFAULT_GCP_STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';

/** Default GCP IAM Credentials base URL for SA impersonation. Override via GCP_IAM_CREDENTIALS_BASE_URL env var. */
export const DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

/** Default OAuth state TTL in seconds (10 minutes). Override via GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS = 600;

/** Default OAuth token handle TTL in seconds (5 minutes). Override via GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS = 300;

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
// Context Summarization (Conversation Forking)
// =============================================================================

/** Default Workers AI model for session summarization. Override via CONTEXT_SUMMARY_MODEL env var. */
export const DEFAULT_CONTEXT_SUMMARY_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max summary output length in characters. Override via CONTEXT_SUMMARY_MAX_LENGTH env var. */
export const DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH = 4000;

/** Default timeout (ms) for AI summarization. Override via CONTEXT_SUMMARY_TIMEOUT_MS env var. */
export const DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS = 10000;

/** Default max messages to include in summarization input. Override via CONTEXT_SUMMARY_MAX_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES = 50;

/** Default number of most-recent messages to always include. Override via CONTEXT_SUMMARY_RECENT_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES = 20;

/** Sessions with filtered message count at or below this threshold skip AI and include messages verbatim.
 * Override via CONTEXT_SUMMARY_SHORT_THRESHOLD env var. */
export const DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD = 5;

/** Default number of leading messages always included in summarization chunking.
 * Override via CONTEXT_SUMMARY_HEAD_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_HEAD_MESSAGES = 5;

/** Default number of recent messages included in heuristic fallback summary.
 * Override via CONTEXT_SUMMARY_HEURISTIC_RECENT_MESSAGES env var. */
export const DEFAULT_CONTEXT_SUMMARY_HEURISTIC_RECENT_MESSAGES = 10;

/** Maximum size of contextSummary in bytes (64KB — schema constraint). */
export const MAX_CONTEXT_SUMMARY_BYTES = 65536;

// =============================================================================
// Text-to-Speech (Cloudflare Workers AI)
// =============================================================================

/** Default Workers AI model for text-to-speech. Override via TTS_MODEL env var. */
export const DEFAULT_TTS_MODEL = '@cf/deepgram/aura-2-en';

/** Default TTS voice/speaker. Override via TTS_SPEAKER env var. */
export const DEFAULT_TTS_SPEAKER = 'luna';

/** Default TTS audio encoding. Override via TTS_ENCODING env var. */
export const DEFAULT_TTS_ENCODING = 'mp3';

/** Default Workers AI model for cleaning markdown before TTS. Override via TTS_CLEANUP_MODEL env var. */
export const DEFAULT_TTS_CLEANUP_MODEL = '@cf/google/gemma-3-12b-it';

/** Default max text length (characters) for TTS input. Override via TTS_MAX_TEXT_LENGTH env var.
 * With chunking enabled, this is a soft limit — text beyond this is summarized rather than read verbatim. */
export const DEFAULT_TTS_MAX_TEXT_LENGTH = 100000;

/** Default max output tokens for the markdown cleanup LLM. Override via TTS_CLEANUP_MAX_TOKENS env var. */
export const DEFAULT_TTS_CLEANUP_MAX_TOKENS = 4096;

/** Default timeout (ms) for TTS audio generation per chunk. Override via TTS_TIMEOUT_MS env var. */
export const DEFAULT_TTS_TIMEOUT_MS = 60000;

/** Default timeout (ms) for markdown cleanup LLM call. Override via TTS_CLEANUP_TIMEOUT_MS env var. */
export const DEFAULT_TTS_CLEANUP_TIMEOUT_MS = 15000;

/** Default R2 key prefix for TTS audio files. Override via TTS_R2_PREFIX env var. */
export const DEFAULT_TTS_R2_PREFIX = 'tts';

/** Default max characters per TTS chunk. Text is split at sentence boundaries.
 * Deepgram Aura 2 enforces a hard 2000-character limit; 1800 provides a safe margin.
 * Override via TTS_CHUNK_SIZE env var. */
export const DEFAULT_TTS_CHUNK_SIZE = 1800;

/** Default max number of TTS chunks per request. Prevents CPU time exhaustion
 * on Workers runtime. Override via TTS_MAX_CHUNKS env var. */
export const DEFAULT_TTS_MAX_CHUNKS = 8;

/** Default character threshold above which text is summarized instead of read verbatim.
 * Aligned to DEFAULT_TTS_MAX_CHUNKS × DEFAULT_TTS_CHUNK_SIZE (8 × 1800 = 14400) to ensure
 * summary mode engages before the chunk cap fires. Override via TTS_SUMMARY_THRESHOLD env var. */
export const DEFAULT_TTS_SUMMARY_THRESHOLD = 14400;

/** Default number of retry attempts per TTS chunk generation. Override via TTS_RETRY_ATTEMPTS env var. */
export const DEFAULT_TTS_RETRY_ATTEMPTS = 3;

/** Default base delay (ms) for exponential backoff between TTS retries. Override via TTS_RETRY_BASE_DELAY_MS env var. */
export const DEFAULT_TTS_RETRY_BASE_DELAY_MS = 500;

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

// =============================================================================
// Notification Defaults (Constitution Principle XI — all configurable)
// =============================================================================

/** Maximum notifications stored per user before oldest are auto-deleted */
export const DEFAULT_MAX_NOTIFICATIONS_PER_USER = 500;

/** Auto-delete notifications older than this (milliseconds). Default: 90 days */
export const DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Maximum notifications returned in a single list request */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 50;

/** Maximum page size for notification list requests */
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

/** Default urgency mapping for each notification type */
export const NOTIFICATION_TYPE_URGENCY: Record<string, 'high' | 'medium' | 'low'> = {
  task_complete: 'medium',
  needs_input: 'high',
  error: 'high',
  progress: 'low',
  session_ended: 'medium',
  pr_created: 'medium',
};

/** Batch window for progress notifications — only one per task within this window. Default: 5 minutes.
 * Override via NOTIFICATION_PROGRESS_BATCH_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS = 5 * 60 * 1000;

/** Deduplication window for task_complete notifications. Default: 60 seconds.
 * Override via NOTIFICATION_DEDUP_WINDOW_MS env var. */
export const DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS = 60_000;

/** Maximum length for request_human_input context field */
export const MAX_HUMAN_INPUT_CONTEXT_LENGTH = 4000;

/** Maximum number of options in request_human_input */
export const MAX_HUMAN_INPUT_OPTIONS_COUNT = 10;

/** Maximum length of each option string in request_human_input */
export const MAX_HUMAN_INPUT_OPTION_LENGTH = 200;

/** Maximum length for notification body text */
export const MAX_NOTIFICATION_BODY_LENGTH = 500;

/** Maximum length for full notification message stored in metadata (configurable via env) */
export const MAX_NOTIFICATION_FULL_BODY_LENGTH = 5000;

/** Maximum length for notification title text (after prefix) */
export const MAX_NOTIFICATION_TITLE_LENGTH = 80;

/**
 * Maximum length for notification title text in needs_input notifications.
 * Shorter than the default because the category prefix (e.g., "Approval needed: ")
 * consumes more space.
 */
export const MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT = 70;

/** Valid categories for request_human_input MCP tool */
export const HUMAN_INPUT_CATEGORIES = ['decision', 'clarification', 'approval', 'error_help'] as const;
export type HumanInputCategory = (typeof HUMAN_INPUT_CATEGORIES)[number];
