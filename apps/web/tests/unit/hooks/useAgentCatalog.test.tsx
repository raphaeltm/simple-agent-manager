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

  // Hook-level dedup. Consumers are named generically on purpose: not every real
  // call site routes through this hook yet (see `lib/query-options/agents.ts`).
  it('collapses any number of concurrent consumers into one request', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        first: useAgentCatalog('user-1'),
        second: useAgentCatalog('user-1'),
        third: useAgentCatalog('user-1'),
        fourth: useAgentCatalog('user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => expect(result.current.first.agents).toEqual([AGENT]));
    expect(result.current.fourth.agents).toEqual([AGENT]);
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

  it('isolates the catalog by authenticated query scope', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.listAgents
      .mockResolvedValueOnce({ agents: [{ ...AGENT, name: 'User one agent' }] })
      .mockResolvedValueOnce({ agents: [{ ...AGENT, name: 'User two agent' }] });

    const { result } = renderHook(
      () => ({ userOne: useAgentCatalog('user-1'), userTwo: useAgentCatalog('user-2') }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.agents[0]?.name).toBe('User one agent');
      expect(result.current.userTwo.agents[0]?.name).toBe('User two agent');
    });
    expect(client.getQueryData(['auth', 'user-1', 'agents', 'catalog'])).toBeDefined();
    expect(client.getQueryData(['auth', 'user-2', 'agents', 'catalog'])).toBeDefined();
  });

  it('surfaces the error when the first load fails with nothing cached', async () => {
    const { Wrapper } = createWrapper();
    mocks.listAgents.mockRejectedValue(new Error('agents unavailable'));

    const { result } = renderHook(() => useAgentCatalog('user-1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBe('agents unavailable'));
    expect(result.current.agents).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the cached catalog and suppresses the error when a refresh fails', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentCatalog('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.agents).toEqual([AGENT]));

    mocks.listAgents.mockRejectedValueOnce(new Error('transient'));
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.agents).toEqual([AGENT]);
    expect(result.current.error).toBeNull();
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

  it('serves a remounting consumer from cache', async () => {
    const { Wrapper } = createWrapper();
    const first = renderHook(() => useTrialStatus('user-1'), { wrapper: Wrapper });
    await waitFor(() => expect(first.result.current.available).toBe(true));
    first.unmount();

    const second = renderHook(() => useTrialStatus('user-1'), { wrapper: Wrapper });
    expect(second.result.current.available).toBe(true);
    expect(second.result.current.loading).toBe(false);
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
