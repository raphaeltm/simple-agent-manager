/**
 * Account, project and credential mocks shared by project chat audits that stub `/api/**`
 * (completion-dock-audit, steering-composer-audit).
 */
export const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

export const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

export const MOCK_CLOUD_CREDENTIALS = [
  {
    id: 'cred-cloud-1',
    provider: 'hetzner',
    connected: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

export const MOCK_AGENT_CREDENTIALS = {
  credentials: [
    {
      agentType: 'claude-code',
      provider: 'anthropic',
      credentialKind: 'api-key',
      isActive: true,
      maskedKey: 'sk-ant-••••test',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

export const MOCK_GITHUB_INSTALLATIONS = [
  {
    id: 'gh-inst-1',
    userId: 'user-test-1',
    installationId: 'inst-1',
    accountType: 'personal',
    accountName: 'testuser',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];
