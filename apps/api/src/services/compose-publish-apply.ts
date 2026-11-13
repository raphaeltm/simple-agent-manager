// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
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
