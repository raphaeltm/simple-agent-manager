import {
  DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
  DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
  MAX_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
} from '@simple-agent-manager/project-data/scheduled';
import {
  DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER,
  DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES,
  DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
  DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS,
} from '@simple-agent-manager/scheduler-core';
import {
  DEFAULT_CLEANUP_OWNERSHIP_ALERT_INTERVAL_MS,
  DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS,
  DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING_LIMIT,
  DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT,
  DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS,
  DEFAULT_NODE_LIFETIME_ADMISSION_CUTOFF_PERCENT,
  DEFAULT_NODE_LIFETIME_FORCE_SLEEP_AFTER_MS,
  DEFAULT_NODE_PROVIDER_DELETION_CONFIRM_MAX_MS,
  DEFAULT_NODE_PROVIDER_DELETION_REQUEST_TIMEOUT_MS,
  DEFAULT_WEBHOOK_QUEUE_MAX_PENDING,
  DEFAULT_WEBHOOK_QUEUE_TTL_SECONDS,
  DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  DEFAULT_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
  MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
} from '@simple-agent-manager/shared';

import { DEFAULT_IDEA_CONTENT_MAX_LENGTH } from '../lib/idea-content-limit';
import {
  type AdminSettingDefinition,
  connectorDefinition,
  integerDefinition,
  oauthDefinition,
} from './admin-setting-definitions';
import { agentModelSettingDefinitions } from './agent-models/settings-definition';
import { CONNECTOR_DEFAULTS, type ConnectorSettingKey } from './connector-settings-definition';
import { DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS } from './default-capacity-pool-candidates-common';
import { ENV_KEYS, SECRET_KINDS, SETTING_KEYS } from './platform-config-store';
import { DEFAULT_SESSION_STALE_TURN_NO_WORK_MINUTES } from './session-idleness';
export const CORE_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'operations.nodeCleanupRefusalWarnAfterMs',
    DEFAULT_CLEANUP_REFUSAL_WARN_AFTER_MS,
    'Operations',
    'Cleanup refusal warning and retry interval in milliseconds.',
    { min: 1, max: 86400000 }
  ),
  integerDefinition(
    'operations.nodeCleanupOwnershipAlertIntervalMs',
    DEFAULT_CLEANUP_OWNERSHIP_ALERT_INTERVAL_MS,
    'Operations',
    'Minimum interval between ownership alerts for the same blocked node in milliseconds.',
    { min: 1, max: 604800000 }
  ),
  integerDefinition(
    'operations.nodeCleanupBlockedRetirementMs',
    DEFAULT_NODE_CLEANUP_BLOCKED_RETIREMENT_MS,
    'Operations',
    'Maximum continuous node cleanup refusal in milliseconds before automatic VM retirement or ownership alert.',
    { min: 1, max: 86400000 }
  ),
  integerDefinition(
    'operations.nodeProviderDeletionRequestTimeoutMs',
    DEFAULT_NODE_PROVIDER_DELETION_REQUEST_TIMEOUT_MS,
    'Operations',
    'Time budget in milliseconds for one cleanup attempt that starts a provider VM deletion without waiting for it (log capture, provider auth, ownership re-read, lookup and the delete request).',
    { min: 1000, max: 60000 }
  ),
  integerDefinition(
    'operations.nodeProviderDeletionConfirmMaxMs',
    DEFAULT_NODE_PROVIDER_DELETION_CONFIRM_MAX_MS,
    'Operations',
    'How long in milliseconds a started provider VM deletion may stay unconfirmed before the node is reported blocked and an operator alert is raised.',
    { min: 60000, max: 86400000 }
  ),
  integerDefinition(
    'operations.nodeLifetimeForceSleepAfterMs',
    DEFAULT_NODE_LIFETIME_FORCE_SLEEP_AFTER_MS,
    'Operations',
    'Leeway in milliseconds after a node reaches its absolute lifetime before any session whose agent turn is still running is stopped and force-slept.',
    { min: 1, max: 86400000 }
  ),
  integerDefinition(
    'operations.sessionStaleTurnNoWorkMinutes',
    DEFAULT_SESSION_STALE_TURN_NO_WORK_MINUTES,
    'Operations',
    'Minutes an open agent turn may go with no new message and no background-work progress before it no longer keeps its session awake, so the session can sleep. Applies to sessions whose task is still running. 0 turns the bound off.',
    { min: 0, max: 10080 }
  ),
  integerDefinition(
    'operations.projectDataArchiveMinStorageUsagePercent',
    DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
    'Operations',
    "Percent of its storage limit a project's chat store must reach before the automatic archive sweep moves its ended chats to archive storage. Archiving costs billed row writes and only frees room in that store, so projects below this are left alone. 0 archives every project.",
    { min: 0, max: 100 }
  ),
  integerDefinition(
    'operations.projectDataArchiveStorageTelemetryMaxAgeHours',
    DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
    'Operations',
    'Hours after which a project storage measurement is too old to hold the archive sweep back. A project with no measurement, or only an older one, is archived as if it were under pressure.',
    { min: 1, max: MAX_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS }
  ),
  integerDefinition(
    'operations.nodeLifetimeAdmissionCutoffPercent',
    DEFAULT_NODE_LIFETIME_ADMISSION_CUTOFF_PERCENT,
    'Operations',
    'Percent of the absolute node lifetime, at its end, during which a node takes no new workspace placements. 0 disables the cutoff.',
    { min: 0, max: 99 }
  ),

  integerDefinition(
    'operations.evictionRecoveryRetryBatchSize',
    5,
    'Operations',
    'Failed eviction wakes selected per scheduled sweep.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'operations.evictionRecoveryRetryWallMs',
    10000,
    'Operations',
    'Time budget in milliseconds before starting another failed eviction wake; an in-flight durable wake may finish afterward.',
    { min: 1, max: 30000 }
  ),
  integerDefinition(
    'operations.capacityPoolPublishBudgetMs',
    DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS,
    'Operations',
    'Time budget in milliseconds for writing a changed compute pool catalog in one refresh. SAM keeps writing batches until the catalog is complete or this time is used, then resumes on the next refresh. A pool cannot place new VMs until its catalog is complete. 0 writes one batch per refresh.',
    { min: 0, max: 120000 }
  ),
  integerDefinition(
    'operations.evictionRecoveryRetryDelayMs',
    60000,
    'Operations',
    'Minimum interval in milliseconds between failed eviction wake attempts and preclaim deferrals. Automatic attempts do not decay their budget.',
    { min: 1, max: 86400000 }
  ),
  integerDefinition(
    'operations.deadWakeReconcileBatchSize',
    10,
    'Operations',
    'Dead VM wake claims the scheduled sweep ends per run. A wake is dead when its claim is older than the wake lease and its task is no longer waking; the chat then shows the wake as failed and can be woken again.',
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'operations.githubTriggerQueueMaxPendingLimit',
    DEFAULT_GITHUB_TRIGGER_QUEUE_MAX_PENDING_LIMIT,
    'Operations',
    'Most pending events allowed when someone creates a GitHub trigger or changes its queue limit. Saved automations and waiting events keep their settings.',
    { min: 1, max: Number.MAX_SAFE_INTEGER }
  ),
  integerDefinition(
    'operations.githubTriggerQueueTtlSecondsLimit',
    DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT,
    'Operations',
    `Longest wait allowed for a GitHub trigger, in seconds (default: ${DEFAULT_GITHUB_TRIGGER_QUEUE_TTL_SECONDS_LIMIT / 86400} days). Applies when someone creates a GitHub trigger or changes its maximum wait. Saved automations and waiting events keep their settings.`,
    { min: 1, max: Number.MAX_SAFE_INTEGER }
  ),
  integerDefinition(
    'operations.webhookQueueMaxPending',
    DEFAULT_WEBHOOK_QUEUE_MAX_PENDING,
    'Operations',
    'Most events a signed webhook automation (Slack, HMAC) can hold while its runs are busy. A call that arrives when the line is full is refused with 429 so the sender can retry.',
    { min: 1, max: 1000 }
  ),
  integerDefinition(
    'operations.webhookQueueTtlSeconds',
    DEFAULT_WEBHOOK_QUEUE_TTL_SECONDS,
    'Operations',
    `Longest a signed webhook event waits for a free run before it is dropped, in seconds (default: ${DEFAULT_WEBHOOK_QUEUE_TTL_SECONDS / 3600} hours). Applies to events received after the change.`,
    { min: 60, max: 30 * 86400 }
  ),
  integerDefinition(
    'operations.webhookSignatureToleranceSeconds',
    DEFAULT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
    'Operations',
    "How far a signed webhook timestamp may differ from SAM's clock before the call is refused as stale, in seconds. Slack recommends 300.",
    { min: 30, max: 3600 }
  ),
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
    'operations.accountMapLinkProjectCap',
    10,
    'Operations',
    'Maximum recent projects checked for idea links on the Account Map.',
    { min: 1, max: 10 }
  ),
  integerDefinition(
    'operations.accountMapIdeaCap',
    100,
    'Operations',
    'Maximum recent idea candidates checked for Account Map chat links.',
    { min: 1, max: 100 }
  ),
  integerDefinition(
    'operations.agentLinkedListCap',
    12,
    'Operations',
    'Maximum related items per list in agent context.',
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'operations.agentLinkedUpdatesCap',
    5,
    'Operations',
    'Maximum recent idea notes in agent context.',
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'operations.agentLinkedTextMaxLength',
    300,
    'Operations',
    'Maximum characters per related item text field sent to agents.',
    { min: 50, max: 2000 }
  ),
  integerDefinition(
    'operations.agentLinkedMaxBytes',
    24000,
    'Operations',
    'Maximum serialized bytes of related context returned to an agent.',
    { min: 2000, max: 36000 }
  ),
  integerDefinition(
    'operations.agentIdeaContentPageLength',
    DEFAULT_IDEA_CONTENT_MAX_LENGTH,
    'Operations',
    'Maximum idea content characters in one agent get_idea response.',
    { min: 1000, max: DEFAULT_IDEA_CONTENT_MAX_LENGTH }
  ),
  integerDefinition(
    'operations.workloadIdentityTokenTtlSeconds',
    DEFAULT_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
    'Operations',
    'External workload identity token lifetime in seconds. Changes apply to newly issued tokens.',
    { min: 1, max: MAX_WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS }
  ),
  integerDefinition(
    'operations.provisioningAttemptsPerProviderTier',
    DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER,
    'Operations',
    "Most offerings one task tries from a single provider source before moving to the pool's next-ranked provider (or giving up), under the fallback-chain exhaustion policy.",
    { min: 1, max: 50 }
  ),
  integerDefinition(
    'operations.workspacePlacementMaxRejections',
    DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS,
    'Operations',
    'Consecutive times the node a task selected may refuse its final workspace reservation before the task fails with the refusal reasons. The count resets when a reservation succeeds.',
    { min: 1, max: 20 }
  ),
  integerDefinition(
    'operations.workspacePlacementBacklogConflictRetries',
    DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
    'Operations',
    'Times a task may reselect because the node it ranked first gained queued workspace builds before its reservation, counted until a reservation succeeds (capacity refusals neither add to nor reset the count). After this many, the task places on its next choice without that fairness check; capacity checks still apply. Conflicts never fail a task or provision a node.',
    { min: 1, max: 20 }
  ),
  integerDefinition(
    'operations.workspaceBuildQueueTimeoutMinutes',
    DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES,
    'Operations',
    "Minutes a workspace may wait for its node's single build slot before it times out. Once its build starts, the build gets the full workspace-ready timeout from that moment, so queue time never shortens the build. Workspaces that do not report a build start (direct creates) stay on this budget for the whole start.",
    { min: 5, max: 1440 }
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
];
