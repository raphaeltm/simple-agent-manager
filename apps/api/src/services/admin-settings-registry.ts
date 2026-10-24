// FILE SIZE EXCEPTION: Declarative typed settings registry (data, like schema.ts); split by domain is tracked in idea 01M5NPWZYJ6XK8G1FK9KXEX813. See .claude/rules/18-file-size-limits.md
/** Phase 1 only. Existing readers are wired here after the recovery wave releases integration. */
import {
  DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS,
  DEFAULT_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
  MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import {
  AGENT_EMAIL_SETTINGS,
  type AgentEmailSettingName,
} from './agent-email/setting-definitions';
import {
  agentModelSettingDefinitions,
  type AgentModelSettingKey,
} from './agent-models/settings-definition';
import {
  CONNECTOR_DEFAULTS,
  type ConnectorSettingKey,
  validateConnectorSetting,
} from './connector-settings-definition';
import { ENV_KEYS, SECRET_KINDS, SETTING_KEYS } from './platform-config-store';
import { WORKFLOW_DEFAULTS, WORKFLOW_SETTING_DETAILS } from './workflow-defaults';

export type AdminSettingValue = boolean | number | string | readonly string[] | null;
export type AdminSettingType = 'boolean' | 'integer' | 'string' | 'string-list' | 'enum';
export type AdminSettingName =
  | `workflow.${keyof typeof WORKFLOW_DEFAULTS}`
  | `aiModels.${AgentModelSettingKey}`
  | `connector.${ConnectorSettingKey}`
  | AgentEmailSettingName
  | 'chat.profileUsageWindowDays'
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
  | 'operations.resourceLinkTouchIntervalMs'
  | 'operations.resourceLinkWeakPerTarget'
  | 'operations.resourceLinkWeakCleanupBatchSize'
  | 'operations.resourceLinkProjectCap'
  | 'operations.resourceLinkListCap'
  | 'operations.resourceLinkBatchTargetLimit'
  | 'operations.resourceLinkBatchPerTargetCap'
  | 'operations.resourceLinkContextMaxLength'
  | 'operations.agentIdeaContextMaxLength'
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
  | 'operations.pullRequestRefreshCap'
  | 'operations.pullRequestRefreshTtlSeconds'
  | 'operations.pullRequestRefreshBudgetPerHour'
  | 'operations.pullRequestRefreshBackoffSeconds'
  | 'operations.pullRequestRefreshTimeoutMs'
  | 'operations.pullRequestCheckUpdateCap'
  | 'operations.pullRequestPendingCheckCap'
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

const connectorDescriptions: Record<ConnectorSettingKey, string> = {
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

const connectorEnvironment: Record<ConnectorSettingKey, keyof Env> = {
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

function connectorDefinition(key: ConnectorSettingKey): AdminSettingDefinition {
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

function oauthDefinition(
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

function switchDefinition(
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

function integerDefinition(
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

function validGitLabHost(value: unknown): boolean {
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

const definitions: AdminSettingDefinition[] = [
  integerDefinition(
    'operations.resourceLinkTouchIntervalMs',
    300000,
    'Operations',
    'Minimum interval before a repeated automatic relationship is touched.',
    { min: 0, max: 86400000 }
  ),
  integerDefinition(
    'operations.resourceLinkWeakPerTarget',
    100,
    'Operations',
    'Maximum automatic read/view relationships per target.',
    { min: 1, max: 10000 }
  ),
  integerDefinition(
    'operations.resourceLinkWeakCleanupBatchSize',
    100,
    'Operations',
    'Maximum excess weak relationships removed during one link write.',
    { min: 1, max: 1000 }
  ),
  integerDefinition(
    'operations.resourceLinkProjectCap',
    100000,
    'Operations',
    'Project link count above which new weak relationships are skipped.',
    { min: 100, max: 10000000 }
  ),
  integerDefinition(
    'operations.resourceLinkListCap',
    50,
    'Operations',
    'Maximum items in each linked work read list.',
    { min: 1, max: 500 }
  ),
  integerDefinition(
    'operations.resourceLinkBatchTargetLimit',
    100,
    'Operations',
    'Maximum target ids per batched linked work lookup.',
    { min: 1, max: 500 }
  ),
  integerDefinition(
    'operations.resourceLinkBatchPerTargetCap',
    50,
    'Operations',
    'Maximum session links returned for each target in a batched lookup.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'operations.resourceLinkContextMaxLength',
    500,
    'Operations',
    'Maximum length of an explicit relationship note.',
    { min: 1, max: 5000 }
  ),
  integerDefinition(
    'operations.agentIdeaContextMaxLength',
    20000,
    'Operations',
    'Maximum characters of a linked idea included in an agent session bootstrap.',
    { min: 500, max: 200000 }
  ),
  integerDefinition(
    'operations.workloadIdentityTokenTtlSeconds',
    DEFAULT_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
    'Operations',
    'External workload identity token lifetime in seconds. Changes apply to newly issued tokens.',
    { min: 1, max: MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS }
  ),
  ...Object.keys(CONNECTOR_DEFAULTS).map((key) => connectorDefinition(key as ConnectorSettingKey)),
  ...agentModelSettingDefinitions(),
  oauthDefinition(
    SETTING_KEYS.githubClientId,
    ENV_KEYS.githubClientId,
    'GitHub login OAuth client ID.'
  ),
  oauthDefinition(
    'integration.github.clientSecret',
    ENV_KEYS.githubClientSecret,
    'GitHub login OAuth client secret.',
    { provider: 'github', kind: SECRET_KINDS.githubClientSecret }
  ),
  oauthDefinition(
    SETTING_KEYS.googleClientId,
    ENV_KEYS.googleClientId,
    'Google login OAuth client ID; separate from infrastructure access.'
  ),
  oauthDefinition(
    'integration.google.clientSecret',
    ENV_KEYS.googleClientSecret,
    'Google login OAuth client secret.',
    { provider: 'google', kind: SECRET_KINDS.googleClientSecret }
  ),
  oauthDefinition(
    SETTING_KEYS.googleInfrastructureClientId,
    ENV_KEYS.googleInfrastructureClientId,
    'Google infrastructure OAuth client ID; separate from login.'
  ),
  oauthDefinition(
    'integration.googleInfrastructure.clientSecret',
    ENV_KEYS.googleInfrastructureClientSecret,
    'Google infrastructure OAuth client secret.',
    { provider: 'google-infrastructure', kind: SECRET_KINDS.googleInfrastructureClientSecret }
  ),
  oauthDefinition(
    SETTING_KEYS.gitlabClientId,
    ENV_KEYS.gitlabClientId,
    'GitLab login OAuth client ID.'
  ),
  oauthDefinition(
    'integration.gitlab.clientSecret',
    ENV_KEYS.gitlabClientSecret,
    'GitLab login OAuth client secret.',
    { provider: 'gitlab', kind: SECRET_KINDS.gitlabClientSecret }
  ),
  {
    ...oauthDefinition(
      SETTING_KEYS.gitlabHost,
      ENV_KEYS.gitlabHost,
      'GitLab OAuth host, without paths or credentials.'
    ),
    validate: validGitLabHost,
  },
  switchDefinition(
    'operations.cronSweepsEnabled',
    true,
    'Operations',
    'Allow recurring cron recovery and cleanup sweeps.',
    { legacyKv: 'cron' }
  ),
  switchDefinition(
    'operations.doAlarmsEnabled',
    true,
    'Operations',
    'Allow Durable Object alarm work; disabled alarms re-arm for later.',
    { legacyKv: 'alarms' }
  ),
  switchDefinition(
    'trials.enabled',
    false,
    'Trials',
    'Allow anonymous trials. Fresh installs remain disabled.',
    { legacyKv: 'trials' }
  ),
  ...(Object.keys(WORKFLOW_DEFAULTS) as Array<keyof typeof WORKFLOW_DEFAULTS>).map((key) =>
    integerDefinition(
      `workflow.${key}`,
      WORKFLOW_DEFAULTS[key],
      'Operations',
      WORKFLOW_SETTING_DETAILS[key].description,
      { min: 1, max: WORKFLOW_SETTING_DETAILS[key].max }
    )
  ),
  integerDefinition(
    'collaboration.sessionAccessMaxGrants',
    DEFAULT_SESSION_ACCESS_MAX_GRANTS,
    'Collaboration',
    'Maximum people one chat session can be shared with at a time.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'collaboration.commentMentionsMax',
    DEFAULT_COMMENT_MENTIONS_MAX,
    'Collaboration',
    'Maximum people one comment can @mention.',
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'collaboration.ideaUpdateBodyMaxLength',
    IDEA_UPDATE_DEFAULTS.bodyMaxLength,
    'Collaboration',
    'Maximum characters in an idea update.',
    { min: 100, max: 16_000 }
  ),
  integerDefinition(
    'collaboration.ideaUpdateQuoteMaxLength',
    IDEA_UPDATE_DEFAULTS.quoteMaxLength,
    'Collaboration',
    'Maximum characters in a quoted excerpt on an idea update.',
    { min: 0, max: 4_000 }
  ),
  integerDefinition(
    'collaboration.ideaUpdatePageSize',
    IDEA_UPDATE_DEFAULTS.pageSize,
    'Collaboration',
    'Number of idea updates returned per page.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'collaboration.ideaAgentNoteMinIntervalSeconds',
    IDEA_UPDATE_DEFAULTS.agentMinIntervalSeconds,
    'Collaboration',
    'Minimum seconds between notes from one agent session on one idea.',
    { min: 1, max: 86_400 }
  ),
  integerDefinition(
    'collaboration.commentContextMessages',
    DEFAULT_COMMENT_CONTEXT_MESSAGES,
    'Collaboration',
    'Messages shown before and after a commented message when a comment is opened from the Comments page.',
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'collaboration.commentContextMaxRows',
    DEFAULT_COMMENT_CONTEXT_MAX_ROWS,
    'Collaboration',
    'Most stored rows read before and after a commented message for that view. Agent replies are stored as many streamed rows.',
    { min: 50, max: 5_000 }
  ),
  ...AGENT_EMAIL_SETTINGS.map((setting) =>
    integerDefinition(
      setting.name,
      setting.defaultValue,
      'Email',
      setting.description,
      setting.range
    )
  ),
  integerDefinition(
    'chat.profileUsageWindowDays',
    DEFAULT_PROFILE_USAGE_WINDOW_DAYS,
    'Chat',
    'Days of each person’s own new chats used to put their recent profiles first and to suggest hiding ones they no longer use.',
    { min: 1, max: 365 }
  ),
  integerDefinition(
    'collaboration.commentNotificationWindowSeconds',
    DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS / 1000,
    'Collaboration',
    'Seconds in which repeated comments on one session send one notification per person. Mentions always notify.',
    { min: 60, max: 86_400 }
  ),
  integerDefinition(
    'operations.pullRequestRefreshCap',
    3,
    'Operations',
    'Maximum pull requests scheduled for GitHub refresh on one detail read.',
    { min: 1, max: 20 }
  ),
  integerDefinition(
    'operations.pullRequestRefreshTtlSeconds',
    300,
    'Operations',
    'Age after which a pull request detail is refreshed from GitHub.',
    { min: 30, max: 86400 }
  ),
  integerDefinition(
    'operations.pullRequestRefreshBudgetPerHour',
    120,
    'Operations',
    'Shared GitHub pull request refresh limit per installation each hour.',
    { min: 1, max: 5000 }
  ),
  integerDefinition(
    'operations.pullRequestRefreshBackoffSeconds',
    3600,
    'Operations',
    'Default pause after a GitHub pull request rate limit response.',
    { min: 60, max: 86400 }
  ),
  integerDefinition(
    'operations.pullRequestRefreshTimeoutMs',
    10000,
    'Operations',
    'Timeout for one GitHub pull request refresh request.',
    { min: 1000, max: 30000 }
  ),
  integerDefinition(
    'operations.pullRequestCheckUpdateCap',
    100,
    'Operations',
    'Maximum pull request rows updated by one GitHub check event per project.',
    { min: 1, max: 500 }
  ),
  integerDefinition(
    'operations.pullRequestPendingCheckCap',
    1000,
    'Operations',
    'Maximum unmatched GitHub check observations retained per project repository.',
    { min: 1, max: 10000 }
  ),
  switchDefinition(
    'operations.stalledTaskClassifierEnabled',
    true,
    'Operations',
    'Allow stalled-task classification; existing liveness checks remain active.',
    { legacyEnvironment: 'STALLED_TASK_CLASSIFIER_ENABLED' }
  ),
  switchDefinition(
    'operations.samOperatorDisabled',
    OPERATOR_DEFAULTS.disabled,
    'Operations',
    'Disable the private SAM assistant for every account. Does not opt users in.',
    {}
  ),
  integerDefinition(
    'operations.samOperatorWatchLifetimeMs',
    OPERATOR_DEFAULTS.watchLifetimeMs,
    'Operations',
    'Maximum lifetime in milliseconds of private SAM project-work watches.',
    { min: 1, max: 2_147_483_647 }
  ),
  integerDefinition(
    'operations.samOperatorEventPageSize',
    OPERATOR_DEFAULTS.eventPageSize,
    'Operations',
    'Maximum watches per refresh, events per watch, and visible private SAM work cards.',
    { min: 1, max: MAX_SAM_OPERATOR_EVENT_PAGE_SIZE }
  ),
  integerDefinition(
    'operations.samOperatorWorkRefreshMs',
    OPERATOR_DEFAULTS.workRefreshMs,
    'Operations',
    'Milliseconds between private SAM project-work refreshes.',
    { min: 1_000, max: 2_147_483_647 }
  ),
  integerDefinition(
    'operations.samOperatorWatchRetryLimit',
    OPERATOR_DEFAULTS.watchRetryLimit,
    'Operations',
    'Consecutive failed private SAM watch refreshes before automatic updates stop. A successful pull or requested follow-up resets the count.',
    { min: 1, max: 25 }
  ),
  integerDefinition(
    'operations.samOperatorStreamFlushMs',
    OPERATOR_DEFAULTS.streamFlushMs,
    'Operations',
    'Milliseconds between live updates while the private SAM assistant is answering.',
    { min: 16, max: 2_000 }
  ),
  integerDefinition(
    'operations.samOperatorStreamHeartbeatMs',
    OPERATOR_DEFAULTS.streamHeartbeatMs,
    'Operations',
    'Milliseconds between keep-alive frames on a live SAM answer stream.',
    { min: 1_000, max: 120_000 }
  ),
  integerDefinition(
    'operations.samOperatorStreamMaxSubscribers',
    OPERATOR_DEFAULTS.streamMaxSubscribers,
    'Operations',
    'Browser tabs that can follow one private SAM answer live at the same time.',
    { min: 1, max: 20 }
  ),
];

export const ADMIN_SETTINGS_REGISTRY: readonly AdminSettingDefinition[] = Object.freeze(
  definitions.map((definition) =>
    Object.freeze({
      ...definition,
      ...(definition.range ? { range: Object.freeze(definition.range) } : {}),
      ...(definition.choices ? { choices: Object.freeze(definition.choices) } : {}),
      ...(definition.credential ? { credential: Object.freeze(definition.credential) } : {}),
    })
  )
);

/** Never resolve untrusted names through inherited object properties. */
export function findAdminSetting(name: string): AdminSettingDefinition | undefined {
  return ADMIN_SETTINGS_REGISTRY.find((definition) => definition.name === name);
}

/** Metadata only. Secret effective values must be separately projected to configured/source. */
export function publicAdminSettingDefinition(definition: AdminSettingDefinition) {
  return {
    name: definition.name,
    type: definition.type,
    defaultValue: definition.defaultValue,
    category: definition.category,
    description: definition.description,
    secret: definition.secret,
    risky: definition.risky,
    range: definition.range,
    choices: definition.choices,
  };
}
