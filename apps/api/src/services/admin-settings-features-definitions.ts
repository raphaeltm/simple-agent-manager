import { DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS } from '@simple-agent-manager/shared';

import {
  type AdminSettingDefinition,
  DEFAULT_COMMENT_CONTEXT_MAX_ROWS,
  DEFAULT_COMMENT_CONTEXT_MESSAGES,
  DEFAULT_COMMENT_MENTIONS_MAX,
  DEFAULT_PROFILE_USAGE_WINDOW_DAYS,
  DEFAULT_SESSION_ACCESS_MAX_GRANTS,
  IDEA_UPDATE_DEFAULTS,
  integerDefinition,
  oauthDefinition,
  OPERATOR_DEFAULTS,
  switchDefinition,
  validGitLabHost,
} from './admin-setting-definitions';
import { AGENT_EMAIL_SETTINGS } from './agent-email/setting-definitions';
import {
  DEFAULT_AUTH_READ_ATTEMPTS,
  DEFAULT_CONFIG_READ_TIMEOUT_MS,
  MAX_CONFIG_READ_TIMEOUT_MS,
} from './config-read-deadline';
import { CONNECTOR_READ_SETTINGS } from './connector-read-settings-definition';
import { ENV_KEYS, SETTING_KEYS } from './platform-config-store';
import { WORKFLOW_DEFAULTS, WORKFLOW_SETTING_DETAILS } from './workflow-defaults';
export const FEATURE_SETTINGS: AdminSettingDefinition[] = [
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
  ...CONNECTOR_READ_SETTINGS.map((setting) =>
    integerDefinition(
      setting.name,
      setting.defaultValue,
      'Connector',
      setting.description,
      setting.range
    )
  ),
  integerDefinition(
    'performance.providerCatalogTimeoutMs',
    10_000,
    'Operations',
    'Maximum milliseconds for a provider machine catalog read.',
    { min: 100, max: 120_000 }
  ),
  integerDefinition(
    'performance.githubRequestTimeoutMs',
    5_000,
    'Operations',
    'Maximum milliseconds per GitHub discovery request.',
    { min: 100, max: 120_000 }
  ),
  integerDefinition(
    'performance.githubInstallationsDeadlineMs',
    15_000,
    'Operations',
    'Maximum milliseconds for GitHub installation discovery.',
    { min: 100, max: 120_000 }
  ),
  integerDefinition(
    'performance.projectRecentTimeoutMs',
    3_000,
    'Operations',
    'Maximum milliseconds for optional recent project data.',
    { min: 100, max: 30_000 }
  ),
  integerDefinition(
    'performance.externalReadTimeoutMs',
    5_000,
    'Operations',
    'Maximum milliseconds for admin external analytics reads.',
    { min: 100, max: 120_000 }
  ),
  {
    ...integerDefinition(
      'performance.configReadTimeoutMs',
      DEFAULT_CONFIG_READ_TIMEOUT_MS,
      'Operations',
      'Maximum milliseconds per legacy platform configuration or session read; bootstrap uses the default deadline before D1 settings are available.',
      { min: 100, max: MAX_CONFIG_READ_TIMEOUT_MS }
    ),
  },
  integerDefinition(
    'performance.authReadAttempts',
    DEFAULT_AUTH_READ_ATTEMPTS,
    'Operations',
    'Maximum attempts for an idempotent session read after a configuration outage or timeout.',
    { min: 1, max: 3 }
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
];
