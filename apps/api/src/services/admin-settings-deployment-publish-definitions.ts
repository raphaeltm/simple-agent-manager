import {
  DEFAULT_BUILD_CONTEXT_MAX_BYTES,
  DEFAULT_BUILD_CONTEXT_CLEANUP_BUDGET_MS,
  DEFAULT_BUILD_CONTEXT_CLEANUP_PAGE_SIZE,
  DEFAULT_BUILD_CONTEXT_COLLECT_TIMEOUT_MS,
  DEFAULT_BUILD_CONTEXT_UPLOAD_TTL_SECONDS,
  DEFAULT_BUILD_CONTEXT_RETENTION_HOURS,
} from './build-context-defaults';
import { integerDefinition } from './admin-setting-definitions';
import {
  DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
  MIN_DEPLOY_PUBLISH_JOB_STALL_MS,
} from './deployment-publish-job-defaults';

export const DEPLOYMENT_PUBLISH_SETTINGS = [
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
    DEFAULT_BUILD_CONTEXT_CLEANUP_BUDGET_MS,
    DEFAULT_BUILD_CONTEXT_CLEANUP_PAGE_SIZE,
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
