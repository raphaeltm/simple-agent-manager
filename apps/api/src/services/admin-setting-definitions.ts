import type { Env } from '../env';
import { type AgentEmailSettingName } from './agent-email/setting-definitions';
import { type AgentModelSettingKey } from './agent-models/settings-definition';
import { type ConnectorReadSettingName } from './connector-read-settings-definition';
import {
  CONNECTOR_DEFAULTS,
  type ConnectorSettingKey,
  validateConnectorSetting,
} from './connector-settings-definition';
import { type WORKFLOW_DEFAULTS } from './workflow-defaults';

export type AdminSettingValue = boolean | number | string | readonly string[] | null;

export type AdminSettingType = 'boolean' | 'integer' | 'string' | 'string-list' | 'enum';

export type AdminSettingName =
  | `workflow.${keyof typeof WORKFLOW_DEFAULTS}`
  | `aiModels.${AgentModelSettingKey}`
  | `connector.${ConnectorSettingKey}`
  | ConnectorReadSettingName
  | AgentEmailSettingName
  | 'chat.profileUsageWindowDays'
  | 'chat.profilePinCandidateLimit'
  | 'collaboration.ideaUpdateBodyMaxLength'
  | 'collaboration.ideaUpdateQuoteMaxLength'
  | 'collaboration.ideaUpdatePageSize'
  | 'collaboration.ideaAgentNoteMinIntervalSeconds'
  | 'collaboration.commentContextMaxRows'
  | 'collaboration.commentContextMessages'
  | 'collaboration.commentMentionsMax'
  | 'collaboration.commentNotificationWindowSeconds'
  | 'collaboration.sessionAccessMaxGrants'
  | 'integration.github.clientId'
  | 'integration.github.clientSecret'
  | 'integration.google.clientId'
  | 'integration.google.clientSecret'
  | 'integration.googleInfrastructure.clientId'
  | 'integration.googleInfrastructure.clientSecret'
  | 'integration.gitlab.host'
  | 'integration.gitlab.clientId'
  | 'integration.gitlab.clientSecret'
  | 'operations.workloadIdentityTokenTtlSeconds'
  | 'operations.nodeCleanupBlockedRetirementMs'
  | 'operations.nodeCleanupRefusalWarnAfterMs'
  | 'operations.nodeCleanupOwnershipAlertIntervalMs'
  | 'operations.evictionRecoveryRetryBatchSize'
  | 'operations.evictionRecoveryRetryWallMs'
  | 'operations.evictionRecoveryRetryDelayMs'
  | 'operations.resourceLinkTouchIntervalMs'
  | 'operations.resourceLinkWeakPerTarget'
  | 'operations.resourceLinkWeakCleanupBatchSize'
  | 'operations.resourceLinkProjectCap'
  | 'operations.resourceLinkListCap'
  | 'operations.resourceLinkBatchTargetLimit'
  | 'operations.resourceLinkBatchPerTargetCap'
  | 'operations.resourceLinkContextMaxLength'
  | 'operations.agentIdeaContextMaxLength'
  | 'operations.accountMapLinkProjectCap'
  | 'operations.accountMapIdeaCap'
  | 'operations.agentLinkedListCap'
  | 'operations.agentLinkedUpdatesCap'
  | 'operations.agentLinkedTextMaxLength'
  | 'operations.agentLinkedMaxBytes'
  | 'operations.agentIdeaContentPageLength'
  | 'operations.cronSweepsEnabled'
  | 'operations.doAlarmsEnabled'
  | 'operations.stalledTaskClassifierEnabled'
  | 'operations.samOperatorDisabled'
  | 'operations.samOperatorWatchLifetimeMs'
  | 'operations.samOperatorEventPageSize'
  | 'operations.samOperatorWorkRefreshMs'
  | 'operations.samOperatorWatchRetryLimit'
  | 'operations.samOperatorStreamFlushMs'
  | 'operations.samOperatorStreamHeartbeatMs'
  | 'operations.samOperatorStreamMaxSubscribers'
  | 'operations.githubTriggerQueueMaxPendingLimit'
  | 'operations.githubTriggerQueueTtlSecondsLimit'
  | 'operations.pullRequestRefreshCap'
  | 'operations.pullRequestRefreshTtlSeconds'
  | 'operations.pullRequestRefreshBudgetPerHour'
  | 'operations.pullRequestRefreshBackoffSeconds'
  | 'operations.pullRequestRefreshTimeoutMs'
  | 'operations.pullRequestCheckUpdateCap'
  | 'operations.pullRequestPendingCheckCap'
  | 'performance.providerCatalogTimeoutMs'
  | 'performance.githubRequestTimeoutMs'
  | 'performance.githubInstallationsDeadlineMs'
  | 'performance.projectRecentTimeoutMs'
  | 'performance.externalReadTimeoutMs'
  | 'performance.configReadTimeoutMs'
  | 'performance.authReadAttempts'
  | 'trials.enabled';

export interface AdminSettingDefinition {
  readonly name: AdminSettingName;
  readonly type: AdminSettingType;
  readonly defaultValue: AdminSettingValue;
  readonly category:
    | 'OAuth'
    | 'Connector'
    | 'Operations'
    | 'Trials'
    | 'Collaboration'
    | 'Chat'
    | 'AI models'
    | 'Email';
  readonly description: string;
  readonly secret: boolean;
  readonly risky: boolean;
  readonly legacyEnvironment?: keyof Env;
  readonly legacyKv?: 'cron' | 'alarms' | 'trials';
  readonly credential?: { readonly provider: string; readonly kind: string };
  readonly range?: { readonly min: number; readonly max: number };
  readonly choices?: readonly string[];
  readonly validate: (value: unknown) => boolean;
}

/** Days of a person's own new chats that order their new-chat profile picker (idea 01M5EW9H86VD88S7E3WWA1D9X1). */
export const DEFAULT_PROFILE_USAGE_WINDOW_DAYS = 30;

/** Most profiles one person's "Use in profiles…" list returns; the response says when it cut. */
export const DEFAULT_PROFILE_PIN_CANDIDATE_LIMIT = 500;

/** Collaboration defaults (idea 01M59MYE4GY91BWTE8TZF1ZB5D); admins can change them at runtime. */
export const DEFAULT_SESSION_ACCESS_MAX_GRANTS = 10;

export const DEFAULT_COMMENT_MENTIONS_MAX = 10;

export const IDEA_UPDATE_DEFAULTS = Object.freeze({
  bodyMaxLength: 8_000,
  quoteMaxLength: 1_000,
  pageSize: 30,
  agentMinIntervalSeconds: 60,
});

/**
 * Messages shown each side of a commented message when a comment is read from the Comments
 * page. A message is what the chat displays: a run of streamed agent rows counts once.
 */
export const DEFAULT_COMMENT_CONTEXT_MESSAGES = 6;

/**
 * Stored rows read each side of a commented message for that view. An agent reply is stored as
 * one row per streamed chunk, so this bounds the read when messages are long.
 */
export const DEFAULT_COMMENT_CONTEXT_MAX_ROWS = 1_000;

// A fresh watch performs up to 13 D1 reads and 3 cold ProjectData RPCs.
// Keep one refresh at most 400 caller I/O operations, plus fixed alarm setup.
export const MAX_SAM_OPERATOR_EVENT_PAGE_SIZE = 25;

export const OPERATOR_DEFAULTS = Object.freeze({
  disabled: false,
  watchLifetimeMs: 86_400_000,
  eventPageSize: MAX_SAM_OPERATOR_EVENT_PAGE_SIZE,
  workRefreshMs: 30_000,
  watchRetryLimit: 3,
  // About 12 updates a second reads as smooth typing without a frame per token.
  streamFlushMs: 80,
  // Below common proxy idle timeouts, so a long tool call does not drop the live view.
  streamHeartbeatMs: 15_000,
  streamMaxSubscribers: 4,
});

export const connectorDescriptions: Record<ConnectorSettingKey, string> = {
  enabled: 'Allow authenticated external clients to use the SAM Connector.',
  writeEnabled: 'Allow external Connector clients to perform write operations.',
  clientRegistration: 'Choose open or allowlisted OAuth client registration.',
  allowedRedirectHosts: 'Allowed OAuth redirect hosts; loopback allows local clients.',
  accessTokenTtlSeconds: 'Connector access token lifetime in seconds.',
  refreshTokenTtlSeconds: 'Connector refresh token lifetime in seconds.',
  readRateLimitPerMinute: 'Maximum Connector reads per minute.',
  writeRateLimitPerMinute: 'Maximum Connector writes per minute.',
  maxStartsPerUserPerHour: 'Maximum Connector task starts per user per hour.',
  maxStartsPerUserPerDay: 'Maximum Connector task starts per user per day.',
};

export const connectorEnvironment: Record<ConnectorSettingKey, keyof Env> = {
  enabled: 'CONNECTOR_ENABLED',
  writeEnabled: 'CONNECTOR_WRITE_ENABLED',
  clientRegistration: 'CONNECTOR_CLIENT_REGISTRATION',
  allowedRedirectHosts: 'CONNECTOR_ALLOWED_REDIRECT_HOSTS',
  accessTokenTtlSeconds: 'CONNECTOR_ACCESS_TOKEN_TTL_SECONDS',
  refreshTokenTtlSeconds: 'CONNECTOR_REFRESH_TOKEN_TTL_SECONDS',
  readRateLimitPerMinute: 'CONNECTOR_READ_RATE_LIMIT_PER_MINUTE',
  writeRateLimitPerMinute: 'CONNECTOR_WRITE_RATE_LIMIT_PER_MINUTE',
  maxStartsPerUserPerHour: 'CONNECTOR_MAX_STARTS_PER_USER_PER_HOUR',
  maxStartsPerUserPerDay: 'CONNECTOR_MAX_STARTS_PER_USER_PER_DAY',
};

export function connectorDefinition(key: ConnectorSettingKey): AdminSettingDefinition {
  const value = CONNECTOR_DEFAULTS[key];
  let type: AdminSettingType = 'integer';
  if (key === 'clientRegistration') type = 'enum';
  else if (Array.isArray(value)) type = 'string-list';
  else if (typeof value === 'boolean') type = 'boolean';
  return {
    name: `connector.${key}`,
    type,
    // Reuse the shipped defaults; integration will move their ownership here without duplication.
    defaultValue: Array.isArray(value) ? Object.freeze([...value]) : value,
    category: 'Connector',
    description: connectorDescriptions[key],
    secret: false,
    risky: true,
    legacyEnvironment: connectorEnvironment[key],
    ...(type === 'integer'
      ? { range: { min: key.endsWith('TtlSeconds') ? 60 : 1, max: 2147483647 } }
      : {}),
    ...(type === 'enum' ? { choices: ['open', 'allowlist'] } : {}),
    validate: (input) => validateConnectorSetting(key, input),
  };
}

export function oauthDefinition(
  name: AdminSettingName,
  legacyEnvironment: keyof Env,
  description: string,
  credential?: AdminSettingDefinition['credential']
): AdminSettingDefinition {
  return {
    name,
    type: 'string',
    defaultValue: null,
    category: 'OAuth',
    description,
    secret: Boolean(credential),
    risky: true,
    legacyEnvironment,
    credential,
    validate: (value) => typeof value === 'string' && value.trim().length >= (credential ? 8 : 6),
  };
}

export function switchDefinition(
  name: AdminSettingName,
  defaultValue: boolean,
  category: AdminSettingDefinition['category'],
  description: string,
  legacy: Pick<AdminSettingDefinition, 'legacyEnvironment' | 'legacyKv'>
): AdminSettingDefinition {
  return {
    name,
    type: 'boolean',
    defaultValue,
    category,
    description,
    secret: false,
    risky: true,
    ...legacy,
    validate: (value) => typeof value === 'boolean',
  };
}

export function integerDefinition(
  name: AdminSettingName,
  defaultValue: number,
  category: AdminSettingDefinition['category'],
  description: string,
  range: { min: number; max: number }
): AdminSettingDefinition {
  return {
    name,
    type: 'integer',
    defaultValue,
    category,
    description,
    secret: false,
    risky: false,
    range,
    validate: (value) =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= range.min &&
      value <= range.max,
  };
}

export function validGitLabHost(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}
