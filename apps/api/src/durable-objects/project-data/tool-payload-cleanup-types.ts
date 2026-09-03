import type { ProjectDataCleanupTerminationReason } from './grouped-fts-cleanup';
import type { ProjectDataStorageStatus, ProjectDataStorageTelemetry } from './storage-safety';

export interface ProjectDataToolPayloadCleanupCursor {
  sessionId: string;
  createdAt: number;
  sequence: number;
  messageId: string;
}

export interface ProjectDataToolPayloadCleanupResult {
  projectId: string;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  triggerBytes: number;
  targetBytes: number;
  batchRows: number;
  batchBytes: number;
  maxRowBytes: number;
  sessionsScanned: number;
  rowsScanned: number;
  rowsUpdated: number;
  rowsFailed: number;
  rearchivableOversizedAttemptsReset: number;
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  terminationReason: ProjectDataCleanupTerminationReason;
  reclaimedBytes: number;
  cursor: ProjectDataToolPayloadCleanupCursor | null;
  exhaustedCandidates: boolean;
  recheckAt: number | null;
}

export interface ProjectDataToolPayloadCleanupOptions {
  allowStart?: boolean;
  forceStart?: boolean;
  now?: number;
  nowMs?: () => number;
  transactionSync?: <T>(callback: () => T) => T;
  classifyStatus: (databaseSizeBytes: number) => ProjectDataStorageStatus;
  recordTelemetry: (
    telemetry: ProjectDataStorageTelemetry,
    fields: {
      lastPurgeAt?: number | null;
      lastPurgeReason?: string | null;
      lastPurgeRows?: number | null;
      lastPurgeDatabaseSizeBytes?: number | null;
      lastError?: string | null;
    }
  ) => Promise<void>;
  purgeReason?: string;
}

export const PROJECT_DATA_MANUAL_TOOL_PAYLOAD_CLEANUP_RESULT_VERSION = 1 as const;

export type ProjectDataManualToolPayloadCleanupSkipReason =
  | 'cooldown'
  | 'idempotency_in_progress'
  | 'missing_project_id'
  | 'not_needed';

export type ProjectDataManualToolPayloadCleanupTerminationReason =
  | ProjectDataToolPayloadCleanupResult['terminationReason']
  | ProjectDataManualToolPayloadCleanupSkipReason;

export type ProjectDataManualToolPayloadCleanupInput = {
  reason: string;
  idempotencyKey: string;
  batchRows?: number | null;
  batchBytes?: number | null;
  wallTimeMs?: number | null;
  now?: number;
  nowMs?: () => number;
};

export type ProjectDataManualToolPayloadCleanupBudgets = {
  batchRows: number;
  batchBytes: number;
  wallTimeMs: number;
  maxBatchRows: number;
  maxBatchBytes: number;
  maxWallTimeMs: number;
  recheckMs: number;
};

export type ProjectDataManualToolPayloadCleanupCooldown = {
  active: boolean;
  nextAllowedAt: number;
  remainingMs: number;
  recheckMs: number;
};

export type ProjectDataManualToolPayloadCleanupTelemetry = {
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  terminationReason: ProjectDataManualToolPayloadCleanupTerminationReason;
  rowsScanned: number;
  rowsUpdated: number;
  rowsFailed: number;
  sessionsScanned: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  exhaustedCandidates: boolean;
  cursor: ProjectDataToolPayloadCleanupResult['cursor'];
  recheckAt: number | null;
};

export type ProjectDataManualToolPayloadCleanupResult = {
  version: typeof PROJECT_DATA_MANUAL_TOOL_PAYLOAD_CLEANUP_RESULT_VERSION;
  projectId: string;
  reason: string;
  idempotencyKey: string;
  idempotent: boolean;
  attempted: boolean;
  skipReason: ProjectDataManualToolPayloadCleanupSkipReason | null;
  startedAt: number;
  completedAt: number | null;
  budgets: ProjectDataManualToolPayloadCleanupBudgets;
  cooldown: ProjectDataManualToolPayloadCleanupCooldown;
  telemetry: ProjectDataManualToolPayloadCleanupTelemetry;
  cleanup: ProjectDataToolPayloadCleanupResult | null;
};

export class ProjectDataManualToolPayloadCleanupStateError extends Error {
  readonly code = 'PROJECT_DATA_MANUAL_TOOL_PAYLOAD_CLEANUP_STATE';

  constructor(
    readonly reason: 'idempotency_conflict' | 'invalid_request',
    message: string
  ) {
    super(message);
    this.name = 'ProjectDataManualToolPayloadCleanupStateError';
  }
}
