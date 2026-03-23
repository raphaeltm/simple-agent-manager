import type { VMSize, WorkspaceProfile } from './common';
import type { CredentialProvider } from './credential';
import type { TaskStatus } from './task';
import type { WorkspaceResponse } from './workspace';
import type { ChatSession, ActivityEvent } from './session';

// =============================================================================
// Projects
// =============================================================================

export type ProjectStatus = 'active' | 'detached';

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  installationId: string;
  repository: string;
  defaultBranch: string;
  defaultVmSize?: VMSize | null;
  defaultAgentType?: string | null;
  defaultWorkspaceProfile?: WorkspaceProfile | null;
  defaultProvider?: CredentialProvider | null;
  workspaceIdleTimeoutMs?: number | null;
  nodeIdleTimeoutMs?: number | null;
  status?: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  repository: string;
  githubRepoId: number | null;
  defaultBranch: string;
  status: ProjectStatus;
  activeWorkspaceCount: number;
  activeSessionCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  taskCountsByStatus: Partial<Record<TaskStatus, number>>;
  linkedWorkspaces: number;
}

export interface ProjectDetail extends Project {
  githubRepoId: number | null;
  githubRepoNodeId: string | null;
  status: ProjectStatus;
  lastActivityAt: string | null;
  activeSessionCount: number;
  workspaces: WorkspaceResponse[];
  recentSessions: ChatSession[];
  recentActivity: ActivityEvent[];
}

export interface ProjectDetailResponse extends Project {
  summary: Omit<ProjectSummary, 'id' | 'name' | 'repository' | 'githubRepoId' | 'defaultBranch' | 'status' | 'createdAt'>;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  installationId: string;
  repository: string;
  githubRepoId?: number;
  githubRepoNodeId?: string;
  defaultBranch: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  defaultBranch?: string;
  defaultVmSize?: VMSize | null;
  defaultAgentType?: string | null;
  defaultWorkspaceProfile?: WorkspaceProfile | null;
  defaultProvider?: CredentialProvider | null;
  workspaceIdleTimeoutMs?: number | null;
  nodeIdleTimeoutMs?: number | null;
}

export interface ProjectRuntimeEnvVarResponse {
  key: string;
  value: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectRuntimeEnvVarRequest {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface ProjectRuntimeFileResponse {
  path: string;
  content: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectRuntimeFileRequest {
  path: string;
  content: string;
  isSecret?: boolean;
}

export interface ProjectRuntimeConfigResponse {
  envVars: ProjectRuntimeEnvVarResponse[];
  files: ProjectRuntimeFileResponse[];
}

export interface ListProjectsResponse {
  projects: Project[];
  nextCursor?: string | null;
}
