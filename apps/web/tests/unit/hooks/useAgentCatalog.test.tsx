import type { AgentInfo } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentCatalog } from '../../../src/hooks/useAgentCatalog';
import { useProviderCatalog } from '../../../src/hooks/useProviderCatalog';
import { useTrialStatus } from '../../../src/hooks/useTrialStatus';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getProviderCatalog: vi.fn(),
  getTrialStatus: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgents: mocks.listAgents,
  getProviderCatalog: mocks.getProviderCatalog,
  getTrialStatus: mocks.getTrialStatus,
}));

const AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  configured: true,
  supportsAcp: true,
} as unknown as AgentInfo;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useAgentCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue({ agents: [AGENT] });
  });

  it('deduplicates the five surfaces that read the agent catalog', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        projectChat: useAgentCatalog('user-1'),
        settings: useAgentCatalog('user-1'),
        onboarding: useAgentCatalog('user-1'),
        workspace: useAgentCatalog('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.projectChat.agents).toEqual([AGENT]));
    expect(result.current.workspace.agents).toEqual([AGENT]);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
  });

  it('keeps the catalog visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentCatalog('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.agents).toEqual([AGENT]));

    let resolveRefresh: ((value: { agents: AgentInfo[] }) => void) | undefined;
    mocks.listAgents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.agents).toEqual([AGENT]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.({ agents: [] });
    });
    await waitFor(() => expect(result.current.agents).toEqual([]));
  });

  it('does not refetch on remount inside the long catalog stale window', async () => {
    const { Wrapper } = createWrapper();
    const first = renderHook(() => useAgentCatalog('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(first.result.current.agents).toEqual([AGENT]));
    first.unmount();

    const second = renderHook(() => useAgentCatalog('user-1'), { wrapper: Wrapper });
    expect(second.result.current.agents).toEqual([AGENT]);
    expect(mocks.listAgents).toHaveBeenCalledTimes(1);
  });

  it('issues no request while signed out', async () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useAgentCatalog(''), { wrapper: Wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });
});

describe('useProviderCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCatalog.mockResolvedValue({ catalogs: [{ provider: 'hetzner', sizes: [] }] });
  });

  it('deduplicates concurrent consumers', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        node: useProviderCatalog('user-1'),
        taskForm: useProviderCatalog('user-1'),
        settings: useProviderCatalog('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.node.catalogs).toHaveLength(1));
    expect(result.current.settings.catalog).not.toBeNull();
    expect(mocks.getProviderCatalog).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty catalog rather than an error when the request fails', async () => {
    const { Wrapper } = createWrapper();
    mocks.getProviderCatalog.mockRejectedValue(new Error('unavailable'));

    const { result } = renderHook(() => useProviderCatalog('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Consumers all carry hardcoded size/location fallbacks; an unavailable catalog
    // must not block workspace creation behind an error state.
    expect(result.current.catalogs).toEqual([]);
    expect(result.current.catalog).toBeNull();
  });
});

describe('useTrialStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTrialStatus.mockResolvedValue({ available: true, agentType: 'opencode' });
  });

  it('deduplicates concurrent consumers and exposes availability', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        checklist: useTrialStatus('user-1'),
        createWorkspace: useTrialStatus('user-1'),
        projectChat: useTrialStatus('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.checklist.available).toBe(true));
    expect(result.current.projectChat.available).toBe(true);
    expect(mocks.getTrialStatus).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable rather than throwing when the request fails', async () => {
    const { Wrapper } = createWrapper();
    mocks.getTrialStatus.mockRejectedValue(new Error('nope'));

    const { result } = renderHook(() => useTrialStatus('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.trial).toBeNull();
  });
});
