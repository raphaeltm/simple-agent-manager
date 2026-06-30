import type { AgentInfo, GitHubInstallation } from '@simple-agent-manager/shared';

import type { ProfileDraft } from '../../components/project-onboarding/shared';

/**
 * Mock data for the multi-step onboarding prototype.
 *
 * This page makes NO API calls — every value here stands in for what the real
 * onboarding wizard would load from the control plane. The data deliberately
 * includes stress cases (long account names, many repos, a long branch name)
 * so the layout is exercised at its edges during the visual audit.
 */

export const MOCK_INSTALLATIONS: GitHubInstallation[] = [
  {
    id: 'inst-1',
    accountName: 'raphaeltm',
    accountType: 'User',
    accountAvatarUrl: null,
  } as GitHubInstallation,
  {
    id: 'inst-2',
    accountName: 'a-very-long-organization-name-that-tests-truncation-and-wrapping',
    accountType: 'Organization',
    accountAvatarUrl: null,
  } as GitHubInstallation,
];

export const MOCK_REPOS: Array<{ fullName: string; defaultBranch: string; githubRepoId: number }> = [
  { fullName: 'raphaeltm/simple-agent-manager', defaultBranch: 'main', githubRepoId: 1 },
  { fullName: 'raphaeltm/sam-docs', defaultBranch: 'main', githubRepoId: 2 },
  { fullName: 'raphaeltm/some-experimental-monorepo-with-a-really-long-name', defaultBranch: 'develop', githubRepoId: 3 },
];

export const MOCK_BRANCHES: Array<{ name: string }> = [
  { name: 'main' },
  { name: 'develop' },
  { name: 'feature/extremely-long-branch-name-for-overflow-testing-purposes' },
  { name: 'release/2026.06' },
  { name: 'staging' },
];

export const MOCK_AGENTS: AgentInfo[] = [
  { id: 'claude-code', name: 'Claude Code' } as AgentInfo,
  { id: 'openai-codex', name: 'OpenAI Codex' } as AgentInfo,
  { id: 'gemini-cli', name: 'Gemini CLI' } as AgentInfo,
];

export const DEFAULT_CONVERSATION_DRAFT: ProfileDraft = {
  name: 'Conversation',
  description: '',
  agentType: 'claude-code',
  model: '',
  useCustomGithubPolicy: false,
};

export const DEFAULT_TASK_DRAFT: ProfileDraft = {
  name: 'Task',
  description: '',
  agentType: 'claude-code',
  model: '',
  useCustomGithubPolicy: true,
};
