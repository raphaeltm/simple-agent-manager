// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export {
  DEFAULT_DEPLOY_PUBLISH_CALLBACK_GRACE_MS,
  DEFAULT_DEPLOY_PUBLISH_HEARTBEAT_INTERVAL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MARGIN_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
  MIN_DEPLOY_PUBLISH_JOB_STALL_MS,
} from '@simple-agent-manager/app-deployment';
