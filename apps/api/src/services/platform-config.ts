/*
 * Public entry point for the platform integration config.
 *
 * The implementation is split across siblings to stay under the 800-line hard limit in
 * `.claude/rules/18-file-size-limits.md`; this barrel keeps every existing call site importing
 * from `services/platform-config` unchanged:
 *
 *   platform-config-store.ts       platform_settings / platform_credentials read+write primitives
 *   platform-config-core.ts        per-isolate cache, resolver, and the write path that invalidates it
 *   platform-config-oauth.ts       pure projections of a resolved config + their `get*` wrappers
 *   platform-config-status.ts      setup-wizard status payload
 *   platform-config-setup-token.ts setup-token verification + attempt rate limit
 *
 * Dependencies run one way (barrel -> leaves -> core -> store), so there are no import cycles.
 */

export {
  __resetPlatformConfigCacheForTest,
  completeSetupWithConfig,
  isSetupCompleted,
  previewPlatformIntegrationConfig,
  resolvePlatformConfig,
  resolvePlatformConfigCacheMs,
  savePlatformIntegrationConfig,
  setSetupCompleted,
} from './platform-config-core';
export {
  areGitHubTriggersConfigured,
  getGitHubAppConfig,
  getGitHubOAuthConfig,
  getGitHubWebhookSecret,
  getGitLabOAuthConfig,
  getGoogleInfraOAuthConfig,
  getGoogleLoginOAuthConfig,
  selectGitHubAppConfig,
  selectGitHubOAuthConfig,
  selectGitHubWebhookSecret,
  selectGitLabOAuthConfig,
  selectGoogleInfraOAuthConfig,
  selectGoogleLoginOAuthConfig,
} from './platform-config-oauth';
export { isSetupTokenConfigured, verifySetupToken } from './platform-config-setup-token';
export { getPlatformConfigStatus } from './platform-config-status';
export { SETUP_COMPLETED_SETTING_KEY } from './platform-config-store';
export type {
  IntegrationStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  PlatformIntegrationInput,
  ResolvedPlatformConfig,
  ResolvedPlatformValue,
} from './platform-config-types';
