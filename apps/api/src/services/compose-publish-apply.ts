// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  ComposePublishApplyOptions,
  ComposePublishApplyResult,
  ComposePublishSubmission,
  ComposePublishWarning,
} from '@simple-agent-manager/app-deployment';
export {
  buildComposePublishApplyPayload,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
  DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB,
  extractComposePublishVolumeDeclarations,
} from '@simple-agent-manager/app-deployment';
