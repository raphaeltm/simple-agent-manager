/** Re-export: this module moved to `src/app-deployment/compose-publish-apply.ts`. */
export type {
  ComposePublishApplyOptions,
  ComposePublishApplyResult,
  ComposePublishSubmission,
  ComposePublishWarning,
} from '../app-deployment';
export {
  buildComposePublishApplyPayload,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
  DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB,
  extractComposePublishVolumeDeclarations,
} from '../app-deployment';
