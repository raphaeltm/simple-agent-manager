export type DebugAgentTarget =
  | { errorId: string; startTime?: never; endTime?: never }
  | { errorId?: never; startTime: string; endTime: string };

export interface DebugAgentUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  dailyTokensUsed: number;
  dailyTokenLimit: number;
}

export interface DebugDiagnosis {
  id: string;
  errorId: string | null;
  startTime: string;
  endTime: string;
  diagnosis: string;
  model: string;
  usage: DebugAgentUsage;
  ideaId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface RunDebugDiagnosisRequest {
  errorId?: string;
  startTime?: string;
  endTime?: string;
}

export type DebugDiagnosisRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type DiagnosticIncidentStatus = 'pending' | 'available' | 'failed' | 'expired';

export interface DiagnosticCollectorOutcome {
  name: string;
  status: 'available' | 'failed';
  bytes: number;
  truncated: boolean;
  redactions: number;
  error?: string;
}

export interface DiagnosticIncidentManifest {
  version: number;
  incidentId: string;
  nodeId: string;
  workspaceId?: string;
  source: string;
  createdAt: string;
  collectors: DiagnosticCollectorOutcome[];
  totalBytes: number;
  redactions: number;
  anyTruncated: boolean;
  unavailable?: boolean;
}

export interface DiagnosticArtifactSummary {
  id: string;
  kind: string;
  status: DiagnosticIncidentStatus;
  contentType: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticIncidentSummary {
  id: string;
  platformErrorId: string;
  nodeId: string;
  workspaceId: string | null;
  status: DiagnosticIncidentStatus;
  occurrenceCount: number;
  lastSeenAt: string;
  artifactCount: number;
  totalBytes: number;
  manifest: DiagnosticIncidentManifest | null;
  preview: Record<string, unknown> | null;
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  artifacts: DiagnosticArtifactSummary[];
}

export interface DebugDiagnosisRunEvent {
  id: string;
  runId: string;
  sequence: number;
  stepKey: string;
  eventType: string;
  status: string;
  sourceName: string | null;
  argumentsPreview: string | null;
  evidencePreview: string | null;
  resultCount: number | null;
  durationMs: number | null;
  retryAttempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface DebugDiagnosisRun {
  id: string;
  status: DebugDiagnosisRunStatus;
  errorId: string | null;
  startTime: string;
  endTime: string;
  diagnosisId: string | null;
  retryOfRunId: string | null;
  model: string | null;
  usage: DebugAgentUsage;
  errorMessage: string | null;
  currentStep: string | null;
  heartbeatAt: string | null;
  attempt: number;
  executorVersion: string;
  cancelRequestedAt: string | null;
  deadlineAt: string;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  diagnosis?: DebugDiagnosis | null;
  incident?: DiagnosticIncidentSummary | null;
}

export interface DebugDiagnosisRunDetailResponse {
  run: DebugDiagnosisRun;
  events: DebugDiagnosisRunEvent[];
  nextCursor: number | null;
}
export interface DebugDiagnosisRunEventsResponse {
  events: DebugDiagnosisRunEvent[];
  nextCursor: number | null;
}

export interface RunDebugDiagnosisResponse {
  run?: DebugDiagnosisRun;
  diagnosis?: DebugDiagnosis;
}

export interface DebugDiagnosisListResponse {
  diagnoses: DebugDiagnosis[];
  runs: DebugDiagnosisRun[];
}

export interface SaveDebugDiagnosisIdeaRequest {
  projectId: string;
  title?: string;
}

export interface DebugProjectOption {
  id: string;
  name: string;
}

export interface DebugProjectOptionsResponse {
  projects: DebugProjectOption[];
}
