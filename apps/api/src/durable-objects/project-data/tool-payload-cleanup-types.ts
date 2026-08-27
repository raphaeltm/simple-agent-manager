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
  toolMetadataBytesScanned: number;
  toolMetadataBytesRead: number;
  originalToolMetadataBytes: number;
  storedToolMetadataBytes: number;
  cursor: ProjectDataToolPayloadCleanupCursor | null;
  exhaustedCandidates: boolean;
  recheckAt: number | null;
}

export interface ProjectDataToolPayloadCleanupOptions {
  allowStart?: boolean;
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
}
