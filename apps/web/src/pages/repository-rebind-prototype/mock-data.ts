import {
  AGENT_CATALOG,
  type AgentCredentialInfo,
  type AgentInfo,
  type AvailableRepository,
  type CCConsumerResolutionStatus,
  type CredentialResponse,
  type GitHubInstallation,
  type ProjectDetailResponse,
  type ProjectRepository,
  type ProjectRuntimeConfigResponse,
  type ProviderCatalogResponse,
  type Repository,
  type SubmoduleSuggestion,
} from '@simple-agent-manager/shared';

export type RepositoryHealth = 'active' | 'id-mismatch' | 'access-revoked' | 'detached';

export interface MockRepositoryStatus {
  health: RepositoryHealth;
  storedRepository: string;
  liveRepository: string;
  installationAccount: string;
  storedGitHubRepoId: number;
  liveGitHubRepoId: number | null;
  storedGitHubRepoNodeId: string | null;
  liveGitHubRepoNodeId: string | null;
  checkedAt: string;
  message: string;
  activeWorkspaces: number;
  inProgressTasks: number;
  activeTriggers: number;
}

export interface MockRepositoryChoice {
  repository: string;
  githubRepoId: number;
  githubRepoNodeId: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
  installationAccount: string;
  branches: string[];
  description: string;
  recommended?: boolean;
  disabledReason?: string;
}

export const mockProjectId = 'prototype-smallpath-website';
export const mockUserId = 'prototype-user-raphael';
export const mockCurrentInstallationId = 'inst-smallpathai';

export const mockProject: ProjectDetailResponse = {
  id: mockProjectId,
  userId: mockUserId,
  name: 'Smallpath Website',
  description: 'Production marketing site and agent-managed web surface.',
  installationId: mockCurrentInstallationId,
  repository: 'smallpathai/website',
  defaultBranch: 'main',
  repoProvider: 'github',
  artifactsRepoId: null,
  defaultVmSize: 'medium',
  defaultAgentType: 'openai-codex',
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: null,
  defaultProvider: 'hetzner',
  defaultLocation: 'fsn1',
  agentDefaults: {
    'openai-codex': {
      model: 'gpt-5-codex',
      permissionMode: 'plan',
    },
  },
  workspaceIdleTimeoutMs: 2 * 60 * 60 * 1000,
  nodeIdleTimeoutMs: null,
  taskExecutionTimeoutMs: null,
  maxConcurrentTasks: 4,
  maxDispatchDepth: null,
  maxSubTasksPerTask: null,
  warmNodeTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  status: 'active',
  createdAt: '2026-06-01T05:44:01.313Z',
  updatedAt: '2026-06-22T07:12:44.000Z',
  summary: {
    repoProvider: 'github',
    activeWorkspaceCount: 0,
    activeSessionCount: 4,
    lastActivityAt: '2026-06-01T10:37:43.527Z',
    taskCountsByStatus: {
      completed: 18,
      failed: 1,
      cancelled: 2,
    },
    linkedWorkspaces: 3,
  },
};

export const mockInstallations: GitHubInstallation[] = [
  {
    id: mockCurrentInstallationId,
    userId: mockUserId,
    installationId: '137119416',
    accountType: 'organization',
    accountName: 'SmallpathAI',
    createdAt: '2026-06-01T05:43:18.000Z',
    updatedAt: '2026-06-22T06:52:20.804Z',
  },
  {
    id: 'inst-raphaeltm',
    userId: mockUserId,
    installationId: '118882444',
    accountType: 'personal',
    accountName: 'raphaeltm',
    createdAt: '2026-05-12T14:20:00.000Z',
    updatedAt: '2026-06-20T12:03:00.000Z',
  },
  {
    id: 'inst-long-org',
    userId: mockUserId,
    installationId: '145991082',
    accountType: 'organization',
    accountName: 'ExtremelyLongOrganizationNameForMobileOverflowChecks',
    createdAt: '2026-05-28T09:00:00.000Z',
    updatedAt: '2026-06-18T18:30:00.000Z',
  },
];

export const initialRepositoryStatus: MockRepositoryStatus = {
  health: 'id-mismatch',
  storedRepository: 'smallpathai/website',
  liveRepository: 'SmallpathAI/website',
  installationAccount: 'SmallpathAI',
  storedGitHubRepoId: 1255718467,
  liveGitHubRepoId: 1298849011,
  storedGitHubRepoNodeId: null,
  liveGitHubRepoNodeId: 'R_kgDOPb4ysw',
  checkedAt: '2026-06-22T07:14:18.000Z',
  message:
    'The project still points at smallpathai/website, but GitHub now reports a different repository identity for that name.',
  activeWorkspaces: 0,
  inProgressTasks: 0,
  activeTriggers: 2,
};

export const repositoryChoices: MockRepositoryChoice[] = [
  {
    repository: 'SmallpathAI/website',
    githubRepoId: 1298849011,
    githubRepoNodeId: 'R_kgDOPb4ysw',
    private: true,
    defaultBranch: 'main',
    installationId: mockCurrentInstallationId,
    installationAccount: 'SmallpathAI',
    branches: ['main', 'production', 'sam/repo-rebind-ux', 'legacy-main'],
    description:
      'Current GitHub repository at the same owner/name. Best fit for repairing this project.',
    recommended: true,
  },
  {
    repository: 'SmallpathAI/website-next',
    githubRepoId: 1302198820,
    githubRepoNodeId: 'R_kgDOPd9lZA',
    private: true,
    defaultBranch: 'main',
    installationId: mockCurrentInstallationId,
    installationAccount: 'SmallpathAI',
    branches: ['main', 'production', 'preview', 'renovate/react-19'],
    description: 'A deliberate move to a replacement repository in the same installation.',
  },
  {
    repository:
      'SmallpathAI/website-with-a-very-long-repository-name-that-should-truncate-in-tight-mobile-layouts',
    githubRepoId: 1302198888,
    githubRepoNodeId: 'R_kgDOPd9m88',
    private: true,
    defaultBranch: 'main',
    installationId: mockCurrentInstallationId,
    installationAccount: 'SmallpathAI',
    branches: ['main', 'release/spring-2026', 'owner/repo-name-overflow-audit'],
    description: 'Stress test for long repository names in the picker and review rows.',
  },
  {
    repository: 'raphaeltm/smallpath-personal-site',
    githubRepoId: 1167819092,
    githubRepoNodeId: 'R_kgDORe9rFA',
    private: false,
    defaultBranch: 'main',
    installationId: 'inst-raphaeltm',
    installationAccount: 'raphaeltm',
    branches: ['main', 'demo', 'archive'],
    description:
      'A cross-account move; allowed only if the selected GitHub App installation grants access.',
  },
  {
    repository: 'SmallpathAI/archive-website',
    githubRepoId: 1088801201,
    githubRepoNodeId: 'R_kgDONz88sQ',
    private: true,
    defaultBranch: 'main',
    installationId: mockCurrentInstallationId,
    installationAccount: 'SmallpathAI',
    branches: ['main'],
    description: 'Visible in search results but disabled because it is archived in this prototype.',
    disabledReason: 'Archived repositories cannot be selected.',
  },
];

export const initialAdditionalRepositories: ProjectRepository[] = [
  {
    id: 'repo-row-design-system',
    repository: 'SmallpathAI/design-system',
    githubRepoId: 1199910001,
    githubRepoNodeId: 'R_kgDODesign1',
    status: 'active',
    createdAt: '2026-06-01T06:00:00.000Z',
    updatedAt: '2026-06-21T12:00:00.000Z',
  },
  {
    id: 'repo-row-content',
    repository: 'SmallpathAI/content',
    githubRepoId: 1199910002,
    githubRepoNodeId: 'R_kgDOContent2',
    status: 'access-revoked',
    createdAt: '2026-06-01T06:01:00.000Z',
    updatedAt: '2026-06-21T12:01:00.000Z',
  },
];

export const availableAdditionalRepositories: AvailableRepository[] = [
  {
    repository: 'SmallpathAI/brand-assets',
    githubRepoId: 1199910003,
    githubRepoNodeId: 'R_kgDOBrand3',
    private: true,
  },
  {
    repository: 'SmallpathAI/component-fixtures-with-an-intentionally-long-name',
    githubRepoId: 1199910004,
    githubRepoNodeId: 'R_kgDOFixture4',
    private: true,
  },
  {
    repository: 'SmallpathAI/public-roadmap',
    githubRepoId: 1199910005,
    githubRepoNodeId: 'R_kgDORoadmap5',
    private: false,
  },
];

export const submoduleSuggestions: SubmoduleSuggestion[] = [
  {
    repository: 'SmallpathAI/design-system',
    path: 'packages/design-system',
    accessible: true,
    alreadyAdded: true,
  },
  {
    repository: 'SmallpathAI/brand-assets',
    path: 'assets/brand',
    accessible: true,
    alreadyAdded: false,
  },
  {
    repository: 'external-vendor/private-widget',
    path: 'vendor/widget',
    accessible: false,
    alreadyAdded: false,
  },
];

export const mockRuntimeConfig: ProjectRuntimeConfigResponse = {
  envVars: [
    {
      key: 'PUBLIC_SITE_URL',
      value: 'https://smallpath.ai',
      isSecret: false,
      hasValue: true,
      createdAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
    },
    {
      key: 'SMALLPATH_PREVIEW_TOKEN',
      value: null,
      isSecret: true,
      hasValue: true,
      createdAt: '2026-06-02T10:10:00.000Z',
      updatedAt: '2026-06-02T10:10:00.000Z',
    },
  ],
  files: [
    {
      path: '.env.local',
      content: null,
      isSecret: true,
      hasValue: true,
      createdAt: '2026-06-02T10:20:00.000Z',
      updatedAt: '2026-06-02T10:20:00.000Z',
    },
  ],
};

export const mockProviderCatalog: ProviderCatalogResponse = {
  catalogs: [
    {
      provider: 'hetzner',
      defaultLocation: 'fsn1',
      locations: [
        { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
        { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
        { id: 'hel1', name: 'Helsinki', country: 'FI' },
      ],
      sizes: {
        small: { type: 'cx23', price: 'EUR 3.79/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
        medium: { type: 'cx33', price: 'EUR 7.59/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
        large: { type: 'cx43', price: 'EUR 15.19/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
      },
    },
  ],
};

export const mockCredentials: CredentialResponse[] = [
  {
    id: 'cred-hetzner',
    provider: 'hetzner',
    connected: true,
    createdAt: '2026-05-01T09:00:00.000Z',
  },
  {
    id: 'cred-gcp',
    provider: 'gcp',
    connected: false,
    createdAt: '2026-05-04T09:00:00.000Z',
  },
];

export const mockAgents: AgentInfo[] = AGENT_CATALOG.map((agent) => ({
  id: agent.id,
  name: agent.name,
  description: agent.description,
  supportsAcp: agent.supportsAcp,
  configured: agent.id === 'openai-codex' || agent.id === 'claude-code',
  credentialHelpUrl: 'https://example.com/agent-credentials',
  fallbackCredentialSource: agent.id === 'opencode' ? 'platform-opencode' : null,
}));

export const mockUserAgentCredentials: AgentCredentialInfo[] = [
  {
    agentType: 'openai-codex',
    provider: 'openai',
    credentialKind: 'oauth-token',
    isActive: true,
    maskedKey: 'codex-auth-json',
    validation: { valid: true, message: 'Looks valid', validationMode: 'format' },
    label: 'Codex OAuth',
    scope: 'user',
    createdAt: '2026-05-30T08:00:00.000Z',
    updatedAt: '2026-06-20T08:00:00.000Z',
  },
  {
    agentType: 'claude-code',
    provider: 'anthropic',
    credentialKind: 'api-key',
    isActive: true,
    maskedKey: 'sk-ant-...3dp',
    validation: { valid: true, message: 'Looks valid', validationMode: 'format' },
    scope: 'user',
    createdAt: '2026-05-30T08:05:00.000Z',
    updatedAt: '2026-06-20T08:05:00.000Z',
  },
];

export const mockProjectAgentCredentials: AgentCredentialInfo[] = [
  {
    agentType: 'openai-codex',
    provider: 'openai',
    credentialKind: 'oauth-token',
    isActive: true,
    maskedKey: 'project-codex-auth-json',
    validation: { valid: true, message: 'Project override is usable', validationMode: 'format' },
    label: 'Smallpath Website override',
    scope: 'project',
    projectId: mockProjectId,
    createdAt: '2026-06-01T06:20:00.000Z',
    updatedAt: '2026-06-21T16:30:00.000Z',
  },
];

export const mockResolutionStatus: { consumers: CCConsumerResolutionStatus[] } = {
  consumers: [
    {
      consumerId: 'openai-codex',
      consumerKind: 'agent',
      consumerName: 'OpenAI Codex',
      source: 'project-attachment',
      credentialName: 'Smallpath Website override',
      configurationName: 'Codex OAuth',
      credentialKind: 'auth-json',
      validation: { status: 'valid', message: 'Project override is active.' },
      halted: false,
    },
    {
      consumerId: 'claude-code',
      consumerKind: 'agent',
      consumerName: 'Claude Code',
      source: 'user-attachment',
      credentialName: 'Claude Max',
      configurationName: 'Default Claude Code',
      credentialKind: 'oauth-token',
      validation: { status: 'valid', message: 'User default is active.' },
      halted: false,
    },
    {
      consumerId: 'google-gemini',
      consumerKind: 'agent',
      consumerName: 'Gemini CLI',
      source: 'unresolved',
      credentialName: null,
      credentialKind: null,
      halted: false,
    },
    {
      consumerId: 'hetzner',
      consumerKind: 'compute',
      consumerName: 'Hetzner',
      source: 'user-attachment',
      credentialName: 'Hetzner primary',
      configurationName: 'Default compute',
      credentialKind: 'cloud-provider',
      halted: false,
    },
    {
      consumerId: 'gcp',
      consumerKind: 'compute',
      consumerName: 'Google Cloud',
      source: 'unresolved',
      credentialName: null,
      credentialKind: null,
      halted: false,
    },
  ],
};

export const mockRepositoryList: Repository[] = repositoryChoices.map((repo) => ({
  id: repo.githubRepoId,
  fullName: repo.repository,
  name: repo.repository.split('/')[1] ?? repo.repository,
  private: repo.private,
  defaultBranch: repo.defaultBranch,
  installationId: repo.installationId,
}));
