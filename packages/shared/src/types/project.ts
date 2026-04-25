import type { AgentType } from '../agents';
import type { ActivityEvent } from './activity';
import type { AgentPermissionMode } from './agent-settings';
import type { ChatSession } from './session';
import type { TaskStatus } from './task';
import type { CredentialProvider } from './user';
import type { VMSize, WorkspaceProfile, WorkspaceResponse } from './workspace';

// =============================================================================
// Projects
// =============================================================================

export type ProjectStatus = 'active' | 'detached';

/** Git repository provider for a project. */
export type RepoProvider = 'github' | 'artifacts';

/**
 * Per-project agent defaults. Keys are agent types (claude-code, openai-codex, etc.).
 * For each agent type, optionally override model and/or permission mode.
 * Null/missing entries fall through to user-level agent_settings.
 */
export type ProjectAgentDefaults = Partial<
  Record<
    AgentType,
    {
      model?: string | null;
      permissionMode?: AgentPermissionMode | null;
    }
  >
>;

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  installationId: string | null;
  repository: string;
  defaultBranch: string;
  /** Repo provider: 'github' (default) or 'artifacts'. */
  repoProvider: RepoProvider;
  /** Cloudflare Artifacts repo ID. Null for GitHub-backed projects. */
  artifactsRepoId?: string | null;
  defaultVmSize?: VMSize | null;
  defaultAgentType?: string | null;
  defaultWorkspaceProfile?: WorkspaceProfile | null;
  /** Default devcontainer config name. null = auto-discover default. */
  defaultDevcontainerConfigName?: string | null;
  defaultProvider?: CredentialProvider | null;
  defaultLocation?: string | null;
  /** Per-agent-type model + permission mode overrides.
   *  Resolution chain: task explicit > agent profile > project.agentDefaults[agentType] > user agent_settings > platform default. */
  agentDefaults?: ProjectAgentDefaults | null;
  workspaceIdleTimeoutMs?: number | null;
  nodeIdleTimeoutMs?: number | null;
  // Per-project scaling parameters (null = use platform default)
  taskExecutionTimeoutMs?: number | null;
  maxConcurrentTasks?: number | null;
  maxDispatchDepth?: number | null;
  maxSubTasksPerTask?: number | null;
  warmNodeTimeoutMs?: number | null;
  maxWorkspacesPerNode?: number | null;
  nodeCpuThresholdPercent?: number | null;
  nodeMemoryThresholdPercent?: number | null;
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
  repoProvider: RepoProvider;
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
  /** Required for GitHub projects. Null/omitted for Artifacts. */
  installationId?: string;
  /** Required for GitHub projects. Auto-generated for Artifacts. */
  repository?: string;
  githubRepoId?: number;
  githubRepoNodeId?: string;
  defaultBranch?: string;
  /** Repo provider: 'github' (default) or 'artifacts'. */
  repoProvider?: RepoProvider;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  defaultBranch?: string;
  defaultVmSize?: VMSize | null;
  defaultAgentType?: string | null;
  defaultWorkspaceProfile?: WorkspaceProfile | null;
  /** Default devcontainer config name. null = reset to auto-discover. */
  defaultDevcontainerConfigName?: string | null;
  defaultProvider?: CredentialProvider | null;
  defaultLocation?: string | null;
  /** Per-agent-type model + permission mode overrides.
   *  null = clear all project-level agent defaults. */
  agentDefaults?: ProjectAgentDefaults | null;
  workspaceIdleTimeoutMs?: number | null;
  nodeIdleTimeoutMs?: number | null;
  // Per-project scaling parameters (null = reset to platform default)
  taskExecutionTimeoutMs?: number | null;
  maxConcurrentTasks?: number | null;
  maxDispatchDepth?: number | null;
  maxSubTasksPerTask?: number | null;
  warmNodeTimeoutMs?: number | null;
  maxWorkspacesPerNode?: number | null;
  nodeCpuThresholdPercent?: number | null;
  nodeMemoryThresholdPercent?: number | null;
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

/** Configurable defaults for Artifacts-backed projects (Constitution Principle XI). */
export const ARTIFACTS_DEFAULTS = {
  /** Default branch for new Artifacts repos. Env: ARTIFACTS_DEFAULT_BRANCH */
  DEFAULT_BRANCH: 'main',
  /** TTL in seconds for generated Artifacts tokens. Env: ARTIFACTS_TOKEN_TTL_SECONDS */
  TOKEN_TTL_SECONDS: 3600,
  /** Maximum Artifacts repos per user. Env: ARTIFACTS_MAX_REPOS_PER_USER */
  MAX_REPOS_PER_USER: 50,
} as const;

/** Valid repo provider values. */
export const VALID_REPO_PROVIDERS: readonly RepoProvider[] = ['github', 'artifacts'] as const;
