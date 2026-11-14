import { choiceDefinition, integerDefinition } from './admin-setting-definitions';
import {
  DEFAULT_BUILD_CONTEXT_CLEANUP_BUDGET_MS,
  DEFAULT_BUILD_CONTEXT_CLEANUP_PAGE_SIZE,
  DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS,
  DEFAULT_BUILD_CONTEXT_COLLECTION_MODE,
  DEFAULT_BUILD_CONTEXT_MAX_BYTES,
  DEFAULT_BUILD_CONTEXT_RETENTION_HOURS,
  DEFAULT_BUILD_CONTEXT_START_TIMEOUT_MS,
  DEFAULT_BUILD_CONTEXT_UPLOAD_TTL_SECONDS,
} from './build-context-defaults';
import {
  DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
  MIN_DEPLOY_PUBLISH_JOB_STALL_MS,
} from './deployment-publish-job-defaults';

export const DEPLOYMENT_PUBLISH_SETTINGS = [
  integerDefinition(
    'deployments.builderCallbackTimeoutMs',
    30000,
    'Operations',
    'Builder control-plane HTTP timeout and bootstrap HTTP shutdown budget.',
    { min: 1000, max: 120000 }
  ),
  integerDefinition(
    'deployments.builderCallbackAttempts',
    3,
    'Operations',
    'Maximum attempts for retryable builder callbacks.',
    { min: 1, max: 10 }
  ),
  integerDefinition(
    'deployments.builderCallbackRetryDelayMs',
    5000,
    'Operations',
    'Delay between retryable builder callbacks.',
    { min: 100, max: 30000 }
  ),
  integerDefinition(
    'deployments.builderDeadlineMs',
    20 * 60_000,
    'Operations',
    'Absolute builder deadline after first admission, also capped by the overall publish-job deadline.',
    { min: 10000, max: 1200000 }
  ),
  choiceDefinition(
    'deployments.buildExecutor',
    'node',
    ['node', 'cloudflare'],
    'Operations',
    'Build executor for VM sessions. Instant always uses Cloudflare; explicit Cloudflare selection never silently falls back to the source node.'
  ),
  integerDefinition(
    'deployments.builderMaxConcurrent',
    6,
    'Operations',
    'Platform Cloudflare build reservations, clamped to the deployed container class maximum.',
    { min: 1, max: 6 }
  ),
  integerDefinition(
    'deployments.builderProjectMaxConcurrent',
    2,
    'Operations',
    'Concurrent Cloudflare builds per project.',
    { min: 1, max: 2 }
  ),
  integerDefinition(
    'deployments.builderCapacityBackoffMs',
    30000,
    'Operations',
    'Minimum delay before retrying Cloudflare platform capacity errors.',
    { min: 1000, max: 300000 }
  ),
  integerDefinition(
    'deployments.builderDrainLimit',
    6,
    'Operations',
    'Maximum queued builds considered per cron tick.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'deployments.builderDaemonReadyTimeoutMs',
    60000,
    'Operations',
    'DinD daemon readiness deadline.',
    { min: 1000, max: 120000 }
  ),
  integerDefinition(
    'deployments.builderHeartbeatIntervalMs',
    15000,
    'Operations',
    'Cloudflare builder heartbeat interval.',
    { min: 1000, max: 30000 }
  ),
  choiceDefinition(
    'deployments.buildContextCollectionMode',
    DEFAULT_BUILD_CONTEXT_COLLECTION_MODE,
    ['off', 'shadow'],
    'Operations',
    'Off preserves node publishing. Shadow asynchronously collects a separate hidden context job without changing build execution.'
  ),
  integerDefinition(
    'deployments.buildContextStartTimeoutMs',
    DEFAULT_BUILD_CONTEXT_START_TIMEOUT_MS,
    'Operations',
    'Maximum control-plane wait for source collection acceptance; collection runs in a source-owned job.',
    { min: 100, max: 30000 }
  ),
  integerDefinition(
    'deployments.buildContextCleanupBudgetMs',
    DEFAULT_BUILD_CONTEXT_CLEANUP_BUDGET_MS,
    'Operations',
    'Context cleanup work budget per daily pass.',
    { min: 100, max: 60000 }
  ),
  integerDefinition(
    'deployments.buildContextCleanupPageSize',
    DEFAULT_BUILD_CONTEXT_CLEANUP_PAGE_SIZE,
    'Operations',
    'Context cleanup list page size; pages continue within the time budget.',
    { min: 1, max: 1000 }
  ),
  integerDefinition(
    'deployments.buildContextMaxBytes',
    DEFAULT_BUILD_CONTEXT_MAX_BYTES,
    'Operations',
    'Maximum raw tar and compressed context bytes per publish job.',
    { min: 1024, max: 5 * 1024 * 1024 * 1024 }
  ),
  integerDefinition(
    'deployments.buildContextCollectTimeoutMs',
    DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS,
    'Operations',
    'Deadline for collecting a portable context on the source runtime.',
    { min: 1000, max: 1200000 }
  ),
  integerDefinition(
    'deployments.buildContextUploadTtlSeconds',
    DEFAULT_BUILD_CONTEXT_UPLOAD_TTL_SECONDS,
    'Operations',
    'Short-lived R2 context upload URL lifetime.',
    { min: 30, max: 900 }
  ),
  integerDefinition(
    'deployments.buildContextRetentionHours',
    DEFAULT_BUILD_CONTEXT_RETENTION_HOURS,
    'Operations',
    'Retention for abandoned and terminal-job context bundles; active jobs remain protected.',
    { min: 1, max: 720 }
  ),
  integerDefinition(
    'deployments.publishJobStallMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
    'Operations',
    'Maximum silence between executor events before failing a heartbeat-capable job as stalled. Legacy jobs are deadline-only.',
    { min: MIN_DEPLOY_PUBLISH_JOB_STALL_MS, max: 86_400_000 }
  ),
  integerDefinition(
    'deployments.publishJobDeadlineMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
    'Operations',
    'Overall publish-job deadline from creation, even while events keep arriving.',
    { min: 10_000, max: 86_400_000 }
  ),
  integerDefinition(
    'deployments.publishJobSweepLimit',
    DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
    'Operations',
    'Maximum expired publish jobs failed per scheduled tick. Each uses one conditional write and one lifecycle delivery.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'deployments.publishJobCancelTimeoutMs',
    DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
    'Operations',
    'Best-effort VM cancellation request timeout after durable cancellation.',
    { min: 100, max: 30_000 }
  ),
];
