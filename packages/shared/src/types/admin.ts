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
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string; // ISO 8601
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
    end: string;   // ISO 8601
  };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
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

// =============================================================================
// Admin Platform Infrastructure
// =============================================================================

export type PlatformInfraAssociationReason = 'trial' | 'support' | 'migration' | 'other';

export interface PlatformInfraUserOption {
  id: string;
  email: string;
  name: string | null;
}

export interface PlatformInfraNodeAssociation {
  nodeId: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  reason: PlatformInfraAssociationReason;
  associatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformInfraTrialSummary {
  id: string;
  status: string;
  repoOwner: string;
  repoName: string;
  claimedByUserId: string | null;
}

export interface PlatformInfraNodeSummary {
  id: string;
  ownerUserId: string;
  name: string;
  status: string;
  healthStatus: string;
  cloudProvider: string | null;
  vmSize: string;
  vmLocation: string;
  credentialSource: string | null;
  lastHeartbeatAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  workspaceCount: number;
  activeWorkspaceCount: number;
  trial: PlatformInfraTrialSummary | null;
  association: PlatformInfraNodeAssociation | null;
}

export interface AdminPlatformInfraResponse {
  nodes: PlatformInfraNodeSummary[];
  users: PlatformInfraUserOption[];
}

export interface UpsertPlatformInfraAssociationRequest {
  userId: string;
  reason: PlatformInfraAssociationReason;
}
