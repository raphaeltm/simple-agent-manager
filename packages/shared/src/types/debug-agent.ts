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

export interface RunDebugDiagnosisResponse {
  diagnosis: DebugDiagnosis;
}

export interface DebugDiagnosisListResponse {
  diagnoses: DebugDiagnosis[];
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
