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
  summary: Omit<
    ProjectSummary,
    'id' | 'name' | 'repository' | 'githubRepoId' | 'defaultBranch' | 'status' | 'createdAt'
  >;
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

// =============================================================================
// Project Repository Access (same-org additional repos for submodule support)
// =============================================================================

/** Status of an additional repository in a project's repository-access set.
 *  - `active`: user∩app access verified at last check.
 *  - `access-revoked`: repo no longer accessible through the installation.
 *  - `app-not-installed`: the GitHub App is no longer installed on the repo's owner.
 *  - `unsupported-url`: a discovered submodule URL could not be parsed as a GitHub repo. */
export type ProjectRepositoryStatus =
  | 'active'
  | 'access-revoked'
  | 'app-not-installed'
  | 'unsupported-url';

/** An additional repository granted to a project's workspace tokens.
 *  The primary project repository is always included implicitly and is not
 *  represented as one of these rows. */
export interface ProjectRepository {
  id: string;
  /** Full repository name, e.g. "octocat/hello-world". */
  repository: string;
  githubRepoId: number;
  githubRepoNodeId: string | null;
  status: ProjectRepositoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepositoryAccessResponse {
  /** Always-included primary project repository (read-only, for display). */
  primaryRepository: string;
  /** Selected additional repositories. */
  repositories: ProjectRepository[];
}

export interface AddProjectRepositoryRequest {
  /** Full repository name, e.g. "octocat/hello-world". */
  repository: string;
}

/** A repository suggested from the primary repo's `.gitmodules`, annotated with
 *  whether it is accessible through the project's GitHub App installation. */
export interface SubmoduleSuggestion {
  /** Full repository name parsed from the submodule URL, e.g. "octocat/lib". */
  repository: string;
  /** Submodule path within the primary repo (from `.gitmodules`). */
  path: string;
  /** True when the repo is accessible through the installation (can be added). */
  accessible: boolean;
  /** True when this repo is already in the project's repository-access set. */
  alreadyAdded: boolean;
}

export interface SubmoduleDiscoveryResponse {
  suggestions: SubmoduleSuggestion[];
}

/** A repository the user can grant to the project, drawn from the live
 *  user∩app installation intersection. Excludes the primary repository and
 *  repositories already added to the project's repository-access set. */
export interface AvailableRepository {
  /** Full repository name, e.g. "octocat/hello-world". */
  repository: string;
  githubRepoId: number;
  githubRepoNodeId: string | null;
  /** Whether the repository is private (for display). */
  private: boolean;
}

export interface AvailableRepositoriesResponse {
  /** Repositories selectable for this project, sorted by full name. */
  repositories: AvailableRepository[];
}

// =============================================================================
// Project Members and Invite Links
// =============================================================================

export type ProjectMemberRole = 'owner' | 'admin' | 'maintainer' | 'viewer';
export type ProjectMemberStatus = 'active' | 'invited' | 'suspended' | 'removed';
export type ProjectAccessRequestStatus = 'pending' | 'approved' | 'denied';
export type ProjectInviteLinkStatus = 'active' | 'expired' | 'revoked';
export type ProjectInviteGithubAccessStatus =
  | 'unchecked'
  | 'verified'
  | 'missing-token'
  | 'no-access'
  | 'unsupported-provider'
  | 'check-failed';

export interface ProjectMemberUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  avatarUrl: string | null;
}

export interface ProjectMemberResponse {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  status: ProjectMemberStatus;
  invitedBy: string | null;
  createdAt: string;
  updatedAt: string;
  user: ProjectMemberUser | null;
}

export interface ProjectInviteLinkResponse {
  id: string;
  projectId: string;
  status: ProjectInviteLinkStatus;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface CreatedProjectInviteLinkResponse extends ProjectInviteLinkResponse {
  token: string;
}

export interface ProjectAccessRequestResponse {
  id: string;
  projectId: string;
  inviteLinkId: string | null;
  requesterUserId: string;
  status: ProjectAccessRequestStatus;
  githubAccessStatus: ProjectInviteGithubAccessStatus;
  githubAccessCheckedAt: string | null;
  githubAccessMessage: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
  requester: ProjectMemberUser | null;
}

export interface ProjectMembersResponse {
  members: ProjectMemberResponse[];
  inviteLinks: ProjectInviteLinkResponse[];
  accessRequests: ProjectAccessRequestResponse[];
}

export type ProjectMemberOffboardingPlanStatus = 'preview' | 'applied' | 'expired';
export type ProjectMemberOffboardingResourceKind =
  | 'trigger'
  | 'task_tree'
  | 'node'
  | 'deployment_environment'
  | 'project_attachment';
export type ProjectMemberOffboardingCredentialSource =
  | 'user'
  | 'project'
  | 'platform'
  | 'unknown';
export type ProjectMemberOffboardingAction =
  | 'reattach_to_project'
  | 'break_and_flag'
  | 'defer_removal';
export type ProjectMemberOffboardingResourceStatus = 'pending' | 'applied' | 'skipped';

export interface ProjectMemberOffboardingResourcePreview {
  resourceKind: ProjectMemberOffboardingResourceKind;
  resourceId: string;
  title: string;
  subtitle: string | null;
  href: string | null;
  credentialSourceBefore: ProjectMemberOffboardingCredentialSource;
  attributionUserIdBefore: string | null;
  attributionProjectIdBefore: string | null;
  recommendedAction: ProjectMemberOffboardingAction;
  availableActions: ProjectMemberOffboardingAction[];
  requiresHumanDecision: boolean;
  blocksRemoval: boolean;
  details: Record<string, unknown>;
}

export interface ProjectMemberOffboardingPreviewResponse {
  offboardingPlanId: string;
  projectId: string;
  memberUserId: string;
  canApply: boolean;
  requiresHumanDecision: boolean;
  summary: {
    breakAndFlag: number;
    reattachAvailable: number;
    blockingTeardown: number;
  };
  resources: ProjectMemberOffboardingResourcePreview[];
}

export type CredentialAttributionConsumerKind = 'agent' | 'compute';
export type CredentialAttributionSource = 'project' | 'personal' | 'platform' | 'unknown';
export type CredentialAttributionResourceKind = 'trigger';

export interface CredentialAttributionUser {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface CredentialAttributionCheck {
  consumerKind: CredentialAttributionConsumerKind;
  consumerTarget: string;
  label: string;
  source: CredentialAttributionSource;
  owner: CredentialAttributionUser | null;
  projectCredential: {
    configurationId: string;
    configurationName: string;
    credentialId: string | null;
    credentialName: string | null;
    owner: CredentialAttributionUser | null;
  } | null;
  fixHref: string;
  warning: string | null;
}

export interface CredentialAttributionResource {
  id: string;
  projectId: string;
  kind: CredentialAttributionResourceKind;
  title: string;
  subtitle: string | null;
  href: string;
  createdBy: CredentialAttributionUser | null;
  checks: CredentialAttributionCheck[];
}

export interface ProjectCredentialAttributionHealthSummary {
  projectId: string;
  counts: {
    resources: number;
    personalResources: number;
    personalCredentials: number;
    projectCoveredCredentials: number;
    unknownCredentials: number;
  };
  resources: CredentialAttributionResource[];
}

export interface ProjectInvitePreviewResponse {
  token: string;
  status: ProjectInviteLinkStatus;
  expiresAt: string;
  project: {
    id: string;
    name: string;
    repository: string;
    repoProvider: RepoProvider;
  };
  membershipStatus:
    | 'active-member'
    | 'pending-request'
    | 'approved-request'
    | 'denied-request'
    | 'can-request';
  accessRequest: ProjectAccessRequestResponse | null;
}

export interface CreateProjectInviteRequest {
  expiresInDays?: number;
}

export interface DecideProjectAccessRequest {
  note?: string;
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
