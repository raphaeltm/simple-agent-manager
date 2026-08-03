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

export type DebugDiagnosisRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

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
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  diagnosis?: DebugDiagnosis | null;
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
