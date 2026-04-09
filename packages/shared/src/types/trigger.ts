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
export const TRIGGERED_BY_VALUES = ['user', 'cron', 'webhook', 'mcp'] as const;
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
  taskMode?: TaskMode;
  vmSizeOverride?: string;
  maxConcurrent?: number;
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
  taskMode?: TaskMode;
  vmSizeOverride?: string | null;
  maxConcurrent?: number;
}

export interface TriggerResponse extends Trigger {
  /** Human-readable description of the cron schedule (e.g., "Every weekday at 9:00 AM UTC"). */
  cronHumanReadable?: string;
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
// Cron Validation Result
// =============================================================================

export interface CronValidationResult {
  valid: boolean;
  error?: string;
  humanReadable?: string;
}
