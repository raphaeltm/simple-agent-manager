import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  createAgentProfile: vi.fn(),
  getAgentCredentialSetupConfig: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listRepositories: vi.fn(),
  saveAgentCredential: vi.fn(),
  validateAgentCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createAgentProfile: mocks.createAgentProfile,
  getAgentCredentialSetupConfig: mocks.getAgentCredentialSetupConfig,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listRepositories: mocks.listRepositories,
  saveAgentCredential: mocks.saveAgentCredential,
  validateAgentCredential: mocks.validateAgentCredential,
}));
vi.mock('../../../src/lib/api/projects', () => ({ createProject: mocks.createProject }));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

import type { GeneratedStep } from '../../../src/components/onboarding/choose-path/path-generator';
import { generatePath } from '../../../src/components/onboarding/choose-path/path-generator';
import { StepExecution } from '../../../src/components/onboarding/choose-path/StepExecution';
import { ToastProvider } from '../../../src/hooks/useToast';

const fresh = { hasAgent: false, hasCloud: false, hasGitHub: false, hasProject: false };
const repo = {
  id: 123,
  fullName: 'acme/web',
  name: 'web',
  private: true,
  defaultBranch: 'trunk',
  installationId: 'inst-1',
};

function renderSteps(props: {
  steps: GeneratedStep[];
  runtime?: 'instant' | 'platform' | 'byoc';
  hostedRepo?: boolean;
  samAvailable?: boolean;
}) {
  const onComplete = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  render(
    <StepExecution
      steps={props.steps}
      runtime={props.runtime}
      hostedRepo={props.hostedRepo ?? false}
      samAvailable={props.samAvailable ?? false}
      onComplete={onComplete}
    />,
    { wrapper: Wrapper }
  );
  return { onComplete, invalidate };
}

async function connectClaudeWithApiKey() {
  fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
  fireEvent.click(screen.getByRole('button', { name: 'API key' }));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), { target: { value: 'sk-1' } });
  fireEvent.click(screen.getByRole('button', { name: /Use this agent/ }));
  await screen.findByRole('heading', { name: 'What are we building?' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentCredentialSetupConfig.mockResolvedValue({
    enabled: true,
    agentTypes: ['openai-codex', 'claude-code'],
  });
  mocks.validateAgentCredential.mockResolvedValue({ valid: true });
  mocks.saveAgentCredential.mockResolvedValue({});
  mocks.createProject.mockResolvedValue({ id: 'project-1' });
  mocks.createAgentProfile.mockResolvedValue({ id: 'profile-1' });
  mocks.listGitHubInstallations.mockResolvedValue([{ id: 'inst-1' }]);
  mocks.listRepositories.mockResolvedValue({ repositories: [repo] });
});

describe('agent step', () => {
  const agentOnly = generatePath(
    { runtime: 'instant', repo: 'hosted' },
    { ...fresh, hasProject: true }
  );

  it.each([
    ['Claude Code', 'Connect with Claude Code'],
    ['OpenAI Codex', 'Connect with Codex'],
  ])('offers the guided %s sign-in first, with paste as the fallback', async (agent, button) => {
    renderSteps({ steps: agentOnly });
    fireEvent.click(screen.getByRole('button', { name: agent }));

    expect(await screen.findByRole('button', { name: button })).toBeInTheDocument();
    expect(await screen.findByLabelText(/^Or paste/)).toBeInTheDocument();
    // The guided sign-in is the action until something is pasted.
    expect(screen.queryByRole('button', { name: 'Save sign-in' })).toBeNull();
  });

  it('falls back to pasting the token where guided sign-in is unavailable', async () => {
    mocks.getAgentCredentialSetupConfig.mockResolvedValue({ enabled: false });
    renderSteps({ steps: agentOnly });
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));

    const field = await screen.findByLabelText('OAuth token');
    await waitFor(() => expect(mocks.getAgentCredentialSetupConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Connect with Claude Code' })).toBeNull();
    fireEvent.change(field, { target: { value: 'tok' } });
    expect(screen.getByRole('button', { name: /Save sign-in/ })).toBeInTheDocument();
  });

  it('offers SAM-managed AI only when the installation enables it', () => {
    renderSteps({ steps: agentOnly, samAvailable: false });
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.queryByRole('button', { name: 'SAM-managed AI' })).toBeNull();
    expect(screen.getByRole('button', { name: 'API key' })).toBeInTheDocument();
  });

  it('shows an API key field for an agent without a subscription', () => {
    renderSteps({ steps: agentOnly });
    fireEvent.click(screen.getByRole('button', { name: 'Gemini CLI' }));
    expect(screen.getByLabelText('Gemini CLI API key')).toBeInTheDocument();
  });
});

describe('cloud step', () => {
  it('uses the shared connect flow with every provider', () => {
    renderSteps({
      steps: generatePath({ runtime: 'byoc', repo: 'hosted' }, { ...fresh, hasAgent: true }),
    });
    expect(screen.getByRole('heading', { name: 'Which cloud should I use?' })).toBeInTheDocument();
    for (const provider of ['Hetzner', 'Scaleway', 'DigitalOcean'])
      expect(screen.getByRole('button', { name: new RegExp(provider) })).toBeInTheDocument();
  });
});

describe('project step', () => {
  it('creates a SAM-hosted project and an Instant profile for the chosen agent', async () => {
    const { onComplete, invalidate } = renderSteps({
      steps: generatePath({ runtime: 'instant', repo: 'hosted' }, fresh),
      runtime: 'instant',
      hostedRepo: true,
    });
    await connectClaudeWithApiKey();

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('project-1'));
    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'my-app',
      repoProvider: 'artifacts',
      defaultBranch: 'main',
    });
    expect(mocks.createAgentProfile).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ agentType: 'claude-code', runtime: 'cf-container' })
    );
    expect(mocks.listGitHubInstallations).not.toHaveBeenCalled();
    // Each finished step refreshes what setup status reads, and nothing else.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['auth', 'user-1', 'agents'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['auth', 'user-1', 'projects'] });
    expect(invalidate).not.toHaveBeenCalledWith();
  });

  it('creates a GitHub project with a full-machine profile on own cloud', async () => {
    const { onComplete } = renderSteps({
      steps: generatePath(
        { runtime: 'byoc', repo: 'github' },
        { ...fresh, hasCloud: true, hasGitHub: true }
      ),
      runtime: 'byoc',
    });
    await connectClaudeWithApiKey();

    fireEvent.change(await screen.findByLabelText('Repository'), {
      target: { value: repo.fullName },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('project-1'));
    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'web',
      repository: 'acme/web',
      installationId: 'inst-1',
      githubRepoId: 123,
      defaultBranch: 'trunk',
    });
    expect(mocks.createAgentProfile).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ runtime: 'vm', taskMode: 'task' })
    );
  });

  it('still finishes when the first profile cannot be created', async () => {
    mocks.createAgentProfile.mockRejectedValue(new Error('conflict'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onComplete } = renderSteps({
      steps: generatePath({ runtime: 'instant', repo: 'hosted' }, fresh),
      runtime: 'instant',
      hostedRepo: true,
    });
    await connectClaudeWithApiKey();
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('project-1'));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('shows the error and stays put when the project cannot be created', async () => {
    mocks.createProject.mockRejectedValue(new Error('Name taken'));
    const { onComplete } = renderSteps({
      steps: generatePath({ runtime: 'instant', repo: 'hosted' }, { ...fresh, hasAgent: true }),
      runtime: 'instant',
      hostedRepo: true,
    });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: /Create project/ }));

    expect(await screen.findByText('Name taken')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    // No agent was picked in this run, so no profile is guessed.
    expect(mocks.createAgentProfile).not.toHaveBeenCalled();
  });
});
