import type { CredentialAttributionCheck } from './project';
import type { TaskMode } from './task';

// =============================================================================
// Trigger Types (Event-Driven Agent Triggers)
// =============================================================================

export const TRIGGER_STATUSES = ['active', 'paused', 'disabled'] as const;
export type TriggerStatus = (typeof TRIGGER_STATUSES)[number];

export const TRIGGER_SOURCE_TYPES = ['cron', 'webhook', 'github'] as const;
export type TriggerSourceType = (typeof TRIGGER_SOURCE_TYPES)[number];

export const TRIGGER_EXECUTION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'skipped',
] as const;
export type TriggerExecutionStatus = (typeof TRIGGER_EXECUTION_STATUSES)[number];

export const TRIGGER_SKIP_REASONS = [
  'still_running',
  'concurrent_limit',
  'rate_limited',
  'paused',
] as const;
export type TriggerSkipReason = (typeof TRIGGER_SKIP_REASONS)[number];

/** Sources that can create a task. */
export const TRIGGERED_BY_VALUES = ['user', 'cron', 'webhook', 'github', 'mcp'] as const;
export type TriggeredBy = (typeof TRIGGERED_BY_VALUES)[number];

// =============================================================================
// Trigger Entity
// =============================================================================

export interface Trigger {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string | null;
  status: TriggerStatus;
  sourceType: TriggerSourceType;
  cronExpression: string | null;
  cronTimezone: string;
  skipIfRunning: boolean;
  promptTemplate: string;
  agentProfileId: string | null;
  skillId: string | null;
  taskMode: TaskMode;
  vmSizeOverride: string | null;
  maxConcurrent: number;
  lastTriggeredAt: string | null;
  triggerCount: number;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Trigger Execution Entity
// =============================================================================

export interface TriggerExecution {
  id: string;
  triggerId: string;
  projectId: string;
  status: TriggerExecutionStatus;
  skipReason: TriggerSkipReason | null;
  taskId: string | null;
  eventType: string;
  renderedPrompt: string | null;
  errorMessage: string | null;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  sequenceNumber: number;
}

// =============================================================================
// API Request / Response Types
// =============================================================================

export interface CreateTriggerRequest {
  name: string;
  description?: string;
  sourceType: TriggerSourceType;
  cronExpression?: string;
  cronTimezone?: string;
  skipIfRunning?: boolean;
  promptTemplate: string;
  agentProfileId?: string;
  skillId?: string;
  taskMode?: TaskMode;
  vmSizeOverride?: string;
  maxConcurrent?: number;
  githubConfig?: {
    eventType: GitHubTriggerEventType;
    filters?: GitHubTriggerFilters;
  };
  webhookConfig?: WebhookTriggerConfigInput;
}

export interface UpdateTriggerRequest {
  name?: string;
  description?: string | null;
  status?: TriggerStatus;
  cronExpression?: string;
  cronTimezone?: string;
  skipIfRunning?: boolean;
  promptTemplate?: string;
  agentProfileId?: string | null;
  skillId?: string | null;
  taskMode?: TaskMode;
  vmSizeOverride?: string | null;
  maxConcurrent?: number;
  githubConfig?: {
    eventType: GitHubTriggerEventType;
    filters?: GitHubTriggerFilters;
  };
  webhookConfig?: WebhookTriggerConfigInput;
}

export interface TriggerResponse extends Trigger {
  /** Human-readable description of the cron schedule (e.g., "Every weekday at 9:00 AM UTC"). */
  cronHumanReadable?: string;
  /** Effective credential attribution checks for this trigger. No secret material is included. */
  credentialAttribution?: {
    multiplayerActive: boolean;
    hasPersonalWarning: boolean;
    checks: CredentialAttributionCheck[];
  };
  /** GitHub trigger configuration, present when sourceType is 'github'. */
  githubConfig?: {
    eventType: GitHubTriggerEventType;
    filters: GitHubTriggerFilters;
  };
  /** Redacted webhook configuration, present when sourceType is 'webhook'. */
  webhookConfig?: WebhookTriggerConfig;
}

/** Create response. The raw webhook credential is present only on webhook creation. */
export interface CreateTriggerResponse extends TriggerResponse {
  webhookCredential?: WebhookCredential;
}

export interface TriggerExecutionResponse extends TriggerExecution {
  createdAt: string;
}

export interface ListTriggersResponse {
  triggers: TriggerResponse[];
}

export interface ListTriggerExecutionsResponse {
  executions: TriggerExecutionResponse[];
  nextCursor?: string | null;
}

export interface TriggerPreviewRequest {
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface TriggerPreviewResponse {
  renderedPrompt: string;
  warnings: string[];
  context: Record<string, unknown>;
  filterResult?: WebhookFilterResult;
}

export type RunTriggerRequest = TriggerPreviewRequest;

// =============================================================================
// Template Context (Cron)
// =============================================================================

/** Context variables available for Mustache-style template interpolation in cron triggers. */
export interface CronTemplateContext {
  schedule: {
    /** ISO 8601 timestamp of when the cron was scheduled to fire. */
    time: string;
    /** Full date string (e.g., "2026-04-09"). */
    date: string;
    /** Day of the week (e.g., "Wednesday"). */
    dayOfWeek: string;
    /** Hour in 24h format (e.g., "14"). */
    hour: string;
    /** Minute (e.g., "30"). */
    minute: string;
    /** IANA timezone of the trigger (e.g., "America/New_York"). */
    timezone: string;
  };
  trigger: {
    /** Trigger ID. */
    id: string;
    /** Trigger name. */
    name: string;
    /** Trigger description. */
    description: string;
    /** How many times this trigger has fired. */
    fireCount: string;
  };
  project: {
    /** Project ID. */
    id: string;
    /** Project name (populated at render time). */
    name: string;
  };
  execution: {
    /** Execution ID. */
    id: string;
    /** Sequence number for this trigger. */
    sequenceNumber: string;
  };
}

// =============================================================================
// GitHub Trigger Configuration
// =============================================================================

/** GitHub event types supported by triggers. */
export const GITHUB_TRIGGER_EVENT_TYPES = [
  'issues',
  'issue_comment',
  'pull_request',
  'push',
] as const;
export type GitHubTriggerEventType = (typeof GITHUB_TRIGGER_EVENT_TYPES)[number];

/** Deterministic filter configuration for GitHub event triggers. */
export interface GitHubTriggerFilters {
  /** GitHub event actions to match (e.g., ['opened', 'labeled'] for issues). Empty = match all actions. */
  actions?: string[];
  /** Required labels — event must have ALL of these labels. */
  labels?: string[];
  /** Actors to ignore (bot usernames like 'dependabot[bot]'). */
  ignoreActors?: string[];
  /** Comment must start with this command prefix (e.g., '/sam' or '@sam'). For issue_comment events. */
  commandPrefix?: string;
  /** Title/body/comment must contain this substring (case-insensitive). */
  bodyContains?: string;
  /** Branch filter — for push/PR events, only match these branches. */
  branches?: string[];
  /** Ignore draft PRs. Default true for pull_request events. */
  ignoreDrafts?: boolean;
}

/** Configuration for a GitHub event trigger (stored in github_trigger_configs table). */
export interface GitHubTriggerConfig {
  id: string;
  triggerId: string;
  eventType: GitHubTriggerEventType;
  filters: GitHubTriggerFilters;
  createdAt: string;
  updatedAt: string;
}

/** API request shape for creating a GitHub trigger. */
export interface CreateGitHubTriggerRequest extends Omit<
  CreateTriggerRequest,
  'cronExpression' | 'cronTimezone'
> {
  sourceType: 'github';
  githubEventType: GitHubTriggerEventType;
  githubFilters?: GitHubTriggerFilters;
}

/** Context variables available for GitHub trigger template interpolation. */
export interface GitHubTemplateContext {
  github: {
    /** The event type (e.g., 'issues', 'issue_comment'). */
    event: string;
    /** The event action (e.g., 'opened', 'labeled'). */
    action: string;
    /** The actor login who triggered the event. */
    actor: string;
    /** The repository full name (e.g., 'owner/repo'). */
    repository: string;
    /** The issue or PR number, if applicable. */
    number: string;
    /** The issue or PR title, if applicable. */
    title: string;
    /** The issue or PR body, if applicable. */
    body: string;
    /** The comment body, for issue_comment events. */
    comment: string;
    /** Comma-separated label names. */
    labels: string;
    /** The branch name (for push/PR events). */
    branch: string;
    /** The commit SHA (for push events). */
    sha: string;
  };
  trigger: {
    id: string;
    name: string;
    description: string;
    fireCount: string;
  };
  project: {
    id: string;
    name: string;
  };
  execution: {
    id: string;
    sequenceNumber: string;
  };
}

// =============================================================================
// Generic Webhook Trigger Configuration
// =============================================================================

export const WEBHOOK_FILTER_OPERATORS = ['exists', 'equals', 'contains'] as const;
export type WebhookFilterOperator = (typeof WEBHOOK_FILTER_OPERATORS)[number];

export const WEBHOOK_FILTER_MODES = ['all', 'any'] as const;
export type WebhookFilterMode = (typeof WEBHOOK_FILTER_MODES)[number];

export interface WebhookTriggerFilter {
  path: string;
  operator: WebhookFilterOperator;
  value?: string | number | boolean | null;
}

export interface WebhookTriggerConfigInput {
  sourceLabel?: string;
  filterMode?: WebhookFilterMode;
  filters?: WebhookTriggerFilter[];
  /** Lowercase header names that may be copied into template context. */
  includedHeaders?: string[];
}

/** Safe configuration returned by management APIs. Token material is never included. */
export interface WebhookTriggerConfig {
  sourceLabel: string | null;
  filterMode: WebhookFilterMode;
  filters: WebhookTriggerFilter[];
  includedHeaders: string[];
  tokenLastFour: string;
  tokenCreatedAt: string;
  tokenRotatedAt: string | null;
}

/** One-time credential returned only when a webhook token is created or rotated. */
export interface WebhookCredential {
  endpointUrl: string;
  token: string;
  headerName: 'Authorization';
}

export interface WebhookTemplateContext {
  webhook: {
    receivedAt: string;
    deliveryId: string;
    sourceLabel: string;
    /** Canonical compact JSON representation of body. */
    payload: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  };
  trigger: {
    id: string;
    name: string;
    description: string;
    fireCount: string;
  };
  project: {
    id: string;
    name: string;
  };
  execution: {
    id: string;
    sequenceNumber: string;
  };
}

export interface WebhookFilterResult {
  matched: boolean;
  reason?: string;
  matchedFilters: number;
  totalFilters: number;
}

export const WEBHOOK_DELIVERY_OUTCOMES = [
  'processing',
  'accepted',
  'duplicate',
  'filtered',
  'inactive',
  'rate_limited',
  'still_running',
  'concurrent_limit',
  'configuration_error',
  'internal_error',
] as const;
export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

export interface WebhookDelivery {
  id: string;
  triggerId: string;
  outcome: WebhookDeliveryOutcome;
  httpStatus: number;
  bodyBytes: number;
  executionId: string | null;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface ListWebhookDeliveriesResponse {
  deliveries: WebhookDelivery[];
  nextCursor: string | null;
}

// =============================================================================
// Cron Validation Result
// =============================================================================

export interface CronValidationResult {
  valid: boolean;
  error?: string;
  humanReadable?: string;
}
