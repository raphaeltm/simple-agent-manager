import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSetupStatus } from '../../../src/hooks/useSetupStatus';

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  listAgentCredentials: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listProjects: vi.fn(),
  listAgents: vi.fn(),
  getInstantRuntimeEnabled: vi.fn(),
  getTrialStatus: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
  listAgentCredentials: mocks.listAgentCredentials,
  listGitHubInstallations: mocks.listGitHubInstallations,
  listProjects: mocks.listProjects,
  listAgents: mocks.listAgents,
  getInstantRuntimeEnabled: mocks.getInstantRuntimeEnabled,
  getTrialStatus: mocks.getTrialStatus,
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

const HETZNER = { id: 'cred-1', provider: 'hetzner', connected: true, isActive: true };
const AGENT_CRED = { agentType: 'claude-code', credentialKind: 'api_key', isActive: true };
const INSTALLATION = { id: 1, accountLogin: 'acme' };

describe('useSetupStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([HETZNER]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [AGENT_CRED] });
    mocks.listGitHubInstallations.mockResolvedValue([INSTALLATION]);
    mocks.listProjects.mockResolvedValue({ projects: [] });
    mocks.listAgents.mockResolvedValue({ agents: [] });
    mocks.getInstantRuntimeEnabled.mockResolvedValue(false);
    mocks.getTrialStatus.mockResolvedValue({ hasInfraCredential: false, hasAgentCredential: true });
  });

  /**
   * The single largest dedup win in the migration.
   *
   * `AppShell` mounts `OnboardingProvider` AND `ChoosePathWizard` on every
   * authenticated page, and each used to issue its own `listCredentials`,
   * `listGitHubInstallations` and `listAgentCredentials` — six requests per page
   * load, before the page itself fetched anything. Both now read this hook.
   */
  it('issues three requests no matter how many consumers mount', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        onboardingProvider: useSetupStatus('user-1'),
        choosePathWizard: useSetupStatus('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.onboardingProvider.loading).toBe(false));
    expect(result.current.choosePathWizard.isComplete).toBe(true);

    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.listGitHubInstallations).toHaveBeenCalledTimes(1);
    // Every fallback read is answered already, so a set-up user pays for none of them.
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(mocks.listAgents).not.toHaveBeenCalled();
    expect(mocks.getInstantRuntimeEnabled).not.toHaveBeenCalled();
    expect(mocks.getTrialStatus).not.toHaveBeenCalled();
  });

  // A SAM-hosted (Cloudflare Artifacts) project is a repository source with no GitHub. Without
  // this the wizard reopened forever for a user who chose not to use GitHub.
  it('is complete without GitHub once the user has a project', async () => {
    const { Wrapper } = createWrapper();
    mocks.listGitHubInstallations.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'project-1' }] });

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasGitHub).toBe(false);
    expect(result.current.hasRepoSource).toBe(true);
    expect(result.current.isComplete).toBe(true);
    expect(mocks.listProjects).toHaveBeenCalledWith(1);
  });

  it('is complete only when the user has their own agent, cloud and a repository source', async () => {
    const { Wrapper } = createWrapper();
    mocks.listGitHubInstallations.mockResolvedValue([]);

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCloud).toBe(true);
    expect(result.current.hasAgent).toBe(true);
    expect(result.current.hasGitHub).toBe(false);
    expect(result.current.isComplete).toBe(false);
  });

  it('does not count an inactive agent credential as configured', async () => {
    const { Wrapper } = createWrapper();
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [{ ...AGENT_CRED, isActive: false }],
    });

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAgent).toBe(false);
    expect(result.current.isComplete).toBe(false);
  });

  /**
   * The pre-migration code used `Promise.allSettled` and treated a rejected read as
   * "absent", so onboarding could still make a decision. A failing read must not be
   * able to pin the caller in a permanent loading state — `OnboardingProvider` gates
   * its overlay policy on `loading`.
   */
  it('resolves rather than hanging when a read fails', async () => {
    const { Wrapper } = createWrapper();
    mocks.listGitHubInstallations.mockRejectedValue(new Error('github down'));

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasGitHub).toBe(false);
    expect(result.current.isComplete).toBe(false);
  });

  it('issues no request and reports not-loading while signed out', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useSetupStatus(''), { wrapper: Wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listCredentials).not.toHaveBeenCalled();
    expect(mocks.listAgentCredentials).not.toHaveBeenCalled();
    expect(mocks.listGitHubInstallations).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('isolates setup status by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    renderHook(() => ({ one: useSetupStatus('user-1'), two: useSetupStatus('user-2') }), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(client.getQueryData(['auth', 'user-1', 'credentials', 'list'])).toBeDefined();
      expect(client.getQueryData(['auth', 'user-2', 'credentials', 'list'])).toBeDefined();
    });
    expect(mocks.listCredentials).toHaveBeenCalledTimes(2);
  });

  // A fresh self-hosted install has no cloud account at all: Instant is what runs agents there.
  it('is complete without a cloud account where Instant runs agents', async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getInstantRuntimeEnabled.mockResolvedValue(true);

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasCloud).toBe(false);
    expect(result.current.instantEnabled).toBe(true);
    expect(result.current.hasCompute).toBe(true);
    expect(result.current.isComplete).toBe(true);
  });

  it("is complete without a cloud account where the installation's own machines exist", async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ hasInfraCredential: true, hasAgentCredential: true });

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.platformCompute).toBe(true);
    expect(result.current.isComplete).toBe(true);
  });

  it('is not complete when agents have nowhere to run', async () => {
    const { Wrapper } = createWrapper();
    mocks.listCredentials.mockResolvedValue([]);

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAgent).toBe(true);
    expect(result.current.hasRepoSource).toBe(true);
    expect(result.current.hasCompute).toBe(false);
    expect(result.current.isComplete).toBe(false);
  });

  // SAM-managed AI is a saved setting rather than a credential; without this the wizard came
  // back forever for a user who picked it.
  it('counts an agent on SAM-managed AI as connected', async () => {
    const { Wrapper } = createWrapper();
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
    mocks.listAgents.mockResolvedValue({
      agents: [
        { id: 'claude-code', configured: true, fallbackCredentialSource: 'platform-sam' },
        { id: 'google-gemini', configured: false, fallbackCredentialSource: null },
      ],
    });

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAgent).toBe(true);
    expect(result.current.isComplete).toBe(true);
  });

  it('is not complete when no agent can sign in', async () => {
    const { Wrapper } = createWrapper();
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
    mocks.listAgents.mockResolvedValue({
      agents: [{ id: 'claude-code', configured: false, fallbackCredentialSource: null }],
    });

    const { result } = renderHook(() => useSetupStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasAgent).toBe(false);
    expect(result.current.isComplete).toBe(false);
  });
});
