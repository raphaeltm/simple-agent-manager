import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentCatalog } from '../../../src/hooks/useAgentCatalog';
import { useAgentProfiles } from '../../../src/hooks/useAgentProfiles';
import { useCredentials } from '../../../src/hooks/useCredentials';
import { useProviderCatalog } from '../../../src/hooks/useProviderCatalog';
import { useTrialStatus } from '../../../src/hooks/useTrialStatus';

/**
 * Measures the dedup win this migration claims, rather than asserting it in prose.
 *
 * Before the migration each of these five endpoints was fetched by an independent
 * `useState`/`useEffect` loader per consuming surface, so mounting N surfaces issued
 * N requests. The counts below are the whole point of routing them through shared
 * query keys, and they are what the PR's before/after table reports.
 */

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  listAgents: vi.fn(),
  listAgentProfiles: vi.fn(),
  getTrialStatus: vi.fn(),
  getProviderCatalog: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listCredentials: mocks.listCredentials,
  listAgents: mocks.listAgents,
  listAgentProfiles: mocks.listAgentProfiles,
  getTrialStatus: mocks.getTrialStatus,
  getProviderCatalog: mocks.getProviderCatalog,
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

const SCOPE = 'user-1';
const PROJECT = 'project-1';

describe('shared query dedup — request counts per flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue({ agents: [] });
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.getTrialStatus.mockResolvedValue({ available: false });
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [] });
  });

  /**
   * Opening project chat used to fire five requests from `useProjectChatState`'s own
   * mount effects, on top of whatever the surrounding surfaces had already fetched.
   * Now the composer, a task form and the settings shell share one entry each.
   */
  it('project-chat open: five endpoints, one request each, however many surfaces mount', async () => {
    const Wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        // Everything the chat page and its neighbours read.
        chatCredentials: useCredentials(SCOPE),
        chatTrial: useTrialStatus(SCOPE),
        chatCatalog: useProviderCatalog(SCOPE),
        chatAgents: useAgentCatalog(SCOPE),
        chatProfiles: useAgentProfiles(PROJECT, SCOPE),
        // A task form and a settings panel mounted alongside it.
        taskFormProfiles: useAgentProfiles(PROJECT, SCOPE),
        taskFormCatalog: useProviderCatalog(SCOPE),
        settingsCredentials: useCredentials(SCOPE),
        settingsAgents: useAgentCatalog(SCOPE),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.chatCredentials.loading).toBe(false);
      expect(result.current.chatProfiles.loading).toBe(false);
      expect(result.current.chatAgents.loading).toBe(false);
    });

    // Nine consumers, five requests.
    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getTrialStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentProfiles).toHaveBeenCalledTimes(1);
  });

  it('navigating away and back re-reads from cache inside the stale window', async () => {
    const Wrapper = createWrapper();

    const visit = renderHook(
      () => ({
        credentials: useCredentials(SCOPE),
        agents: useAgentCatalog(SCOPE),
        profiles: useAgentProfiles(PROJECT, SCOPE),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(visit.result.current.credentials.loading).toBe(false));
    visit.unmount();

    const revisit = renderHook(
      () => ({
        credentials: useCredentials(SCOPE),
        agents: useAgentCatalog(SCOPE),
        profiles: useAgentProfiles(PROJECT, SCOPE),
      }),
      { wrapper: Wrapper }
    );

    // No spinner and no network on the way back — this is what removes the
    // "everything reloads when I navigate" symptom.
    expect(revisit.result.current.credentials.loading).toBe(false);
    expect(revisit.result.current.agents.loading).toBe(false);
    expect(revisit.result.current.profiles.loading).toBe(false);
    expect(mocks.listCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
    expect(mocks.listAgentProfiles).toHaveBeenCalledTimes(1);
  });

  it('a second project does not reuse the first project profile list', async () => {
    const Wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        projectOne: useAgentProfiles('project-1', SCOPE),
        projectTwo: useAgentProfiles('project-2', SCOPE),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.projectOne.loading).toBe(false);
      expect(result.current.projectTwo.loading).toBe(false);
    });
    // Dedup must not go so far as to collapse genuinely different resources.
    expect(mocks.listAgentProfiles).toHaveBeenCalledTimes(2);
  });
});
