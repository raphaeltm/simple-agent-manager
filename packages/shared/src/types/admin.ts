import type { DiagnosticIncidentSummary } from './debug-agent';
import type {
  ProjectEventDeliveryAttemptState,
  ProjectEventDeliveryBatchState,
  ProjectEventDisplayData,
  ProjectEventFilterV1,
  ProjectEventMatchState,
  ProjectEventRequestedDeliveryMode,
  ProjectEventResolvedDeliveryMode,
  ProjectEventSeverity,
  ProjectEventStorageAccountingRecord,
  ProjectEventSubject,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionState,
} from './project-events';

// =============================================================================
// Admin Observability (spec 023)
// =============================================================================

export type PlatformErrorSource = 'client' | 'vm-agent' | 'api';
export type PlatformErrorLevel = 'error' | 'warn' | 'info';

export interface PlatformError {
  id: string;
  source: PlatformErrorSource;
  level: PlatformErrorLevel;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  userId: string | null;
  nodeId: string | null;
  workspaceId: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string; // ISO 8601
  incident?: DiagnosticIncidentSummary | null;
}

/** Bounded admin node summary for the observability node-health table. */
export interface AdminNodeSummary {
  id: string;
  name: string | null;
  status: string;
  healthStatus: string | null;
  lastHeartbeatAt: string | null; // ISO 8601
  provider: string | null;
  nodeClass: string | null;
  vmAgentBuild: string | null;
  errorMessage: string | null;
  createdAt: string; // ISO 8601
}

export interface AdminNodesResponse {
  nodes: AdminNodeSummary[];
}

export interface ErrorListResponse {
  errors: PlatformError[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

export interface HealthSummary {
  activeNodes: number;
  activeWorkspaces: number;
  inProgressTasks: number;
  errorCount24h: number;
  timestamp: string; // ISO 8601
}

// =============================================================================
// Admin Project Event Inspector (superadmin-only, sanitized)
// =============================================================================

export interface AdminProjectEventInspectorProject {
  id: string;
  name: string;
  repository: string | null;
  repoProvider: string | null;
  status: string | null;
  activeSessionCount: number;
  lastActivityAt: string | null;
}

export interface AdminProjectEventInspectorTarget {
  sessionId: string | null;
  taskId: string | null;
  runtimeId: string | null;
  agentId: string | null;
}

export interface AdminProjectEventInspectorSubscription {
  id: string;
  owner: ProjectEventSubscriptionOwner;
  state: ProjectEventSubscriptionState;
  reason: string | null;
  filter: ProjectEventFilterV1;
  matchKeyCount: number;
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
  target: AdminProjectEventInspectorTarget;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  cancelledAt: number | null;
  cancelledBy: ProjectEventSubscriptionOwner | null;
  cancelReason: string | null;
  lastMatchedAt: number | null;
}

export interface AdminProjectEventInspectorEvent {
  id: string;
  source: string;
  eventType: string;
  subject: ProjectEventSubject;
  severity: ProjectEventSeverity;
  state: string;
  display: ProjectEventDisplayData;
  occurredAt: number;
  receivedAt: number;
  updatedAt: number;
  duplicateCount: number;
  conflictCount: number;
  hasRawPayloadRef: boolean;
}

export interface AdminProjectEventInspectorMatch {
  id: string;
  eventId: string;
  subscriptionId: string;
  state: ProjectEventMatchState;
  matchedAt: number;
  lifecycleCheckedAt: number;
  batchId: string | null;
  reason: string | null;
}

export interface AdminProjectEventInspectorAdapterDecision {
  action: string;
  reason: string;
  adapterId: string | null;
  adapterKind: string | null;
  capability: string | null;
  agentType: string | null;
  protocol: string | null;
  protocolVersion: string | null;
  durableAck: boolean;
  supported: boolean;
  authorized: boolean;
  terminal: boolean;
}

export interface AdminProjectEventInspectorBatch {
  id: string;
  subscriptionId: string;
  state: ProjectEventDeliveryBatchState;
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
  target: AdminProjectEventInspectorTarget;
  eventCount: number;
  matchCount: number;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
  terminalReason: string | null;
  adapterDecision: AdminProjectEventInspectorAdapterDecision;
}

export interface AdminProjectEventInspectorAttempt {
  id: string;
  batchId: string;
  attemptNumber: number;
  state: ProjectEventDeliveryAttemptState;
  adapter: string | null;
  protocolVersion: string | null;
  runtimeId: string | null;
  receiptId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
  createdAt: number;
}

export interface AdminProjectEventInspectorTotals {
  activeSubscriptions: number;
  terminalSubscriptions: number;
  recentEvents: number;
  recentMatches: number;
  recentBatches: number;
  recentAttempts: number;
  attentionBatches: number;
  attentionAttempts: number;
}

export interface AdminProjectEventInspectorResponse {
  generatedAt: number;
  limit: number;
  project: AdminProjectEventInspectorProject;
  totals: AdminProjectEventInspectorTotals;
  subscriptions: AdminProjectEventInspectorSubscription[];
  events: AdminProjectEventInspectorEvent[];
  matches: AdminProjectEventInspectorMatch[];
  batches: AdminProjectEventInspectorBatch[];
  attempts: AdminProjectEventInspectorAttempt[];
  accounting: ProjectEventStorageAccountingRecord[];
  hasMore: boolean;
}

export interface ErrorTrendBucket {
  timestamp: string; // ISO 8601
  total: number;
  bySource: Record<PlatformErrorSource, number>;
}

export interface ErrorTrendResponse {
  range: string;
  interval: string;
  buckets: ErrorTrendBucket[];
}

export interface AdminLogEntry {
  timestamp: string; // ISO 8601
  level: string;
  event: string;
  message: string;
  details: Record<string, unknown>;
  invocationId?: string;
}

export interface LogQueryParams {
  timeRange: {
    start: string; // ISO 8601
    end: string; // ISO 8601
  };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
  scriptName?: string;
  /** Caller-supplied queryId for pagination consistency. Generated server-side if omitted. */
  queryId?: string;
}

export interface LogQueryResponse {
  logs: AdminLogEntry[];
  cursor: string | null;
  hasMore: boolean;
  /** The queryId used for this query, returned for pagination consistency. */
  queryId?: string;
}

export type LogStreamMessageType = 'log' | 'pong' | 'status' | 'error';

export interface LogStreamMessage {
  type: LogStreamMessageType;
  entry?: {
    timestamp: string;
    level: string;
    event: string;
    message: string;
    details: Record<string, unknown>;
    scriptName: string;
  };
  connected?: boolean;
  clientCount?: number;
  message?: string;
}

export type LogStreamClientMessageType = 'ping' | 'filter' | 'pause' | 'resume';

export interface LogStreamClientMessage {
  type: LogStreamClientMessageType;
  levels?: string[];
  search?: string;
}
