import type { AgentProfile } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentProfiles } from '../../../src/hooks/useAgentProfiles';

const mocks = vi.hoisted(() => ({
  listAgentProfiles: vi.fn(),
  createAgentProfile: vi.fn(),
  updateAgentProfile: vi.fn(),
  deleteAgentProfile: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listAgentProfiles: mocks.listAgentProfiles,
  createAgentProfile: mocks.createAgentProfile,
  updateAgentProfile: mocks.updateAgentProfile,
  deleteAgentProfile: mocks.deleteAgentProfile,
}));

const PROFILE = {
  id: 'profile-1',
  projectId: 'project-1',
  name: 'Reviewer',
  agentType: 'claude-code',
} as unknown as AgentProfile;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useAgentProfiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentProfiles.mockResolvedValue([PROFILE]);
  });

  it('collapses the surfaces that read the same project profile list into one request', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        profilesPage: useAgentProfiles('project-1', 'user-1'),
        chatComposer: useAgentProfiles('project-1', 'user-1'),
        taskForm: useAgentProfiles('project-1', 'user-1'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.profilesPage.profiles).toEqual([PROFILE]);
      expect(result.current.chatComposer.profiles).toEqual([PROFILE]);
      expect(result.current.taskForm.profiles).toEqual([PROFILE]);
    });
    expect(mocks.listAgentProfiles).toHaveBeenCalledTimes(1);
  });

  it('keeps profiles visible during a background refresh', async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentProfiles('project-1', 'user-1'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.profiles).toEqual([PROFILE]));

    let resolveRefresh: ((value: AgentProfile[]) => void) | undefined;
    mocks.listAgentProfiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.profiles).toEqual([PROFILE]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveRefresh?.([{ ...PROFILE, name: 'Renamed' }]);
    });
    await waitFor(() => expect(result.current.profiles[0]?.name).toBe('Renamed'));
  });

  /**
   * The pre-migration hook did `await api.createAgentProfile(...)` then
   * `await fetchProfiles()` — refreshing only the component that happened to own the
   * loader. A profile created in the chat composer never reached the profiles page.
   * Invalidating the shared entry is what fixes that, so the assertion is about the
   * OTHER consumer seeing the change, not just the mutating one.
   */
  it('propagates a create to every consumer via invalidation, not a local splice', async () => {
    const { Wrapper } = createWrapper();
    const created = { ...PROFILE, id: 'profile-2', name: 'Fixer' };
    mocks.createAgentProfile.mockResolvedValue(created);

    const { result } = renderHook(
      () => ({
        composer: useAgentProfiles('project-1', 'user-1'),
        profilesPage: useAgentProfiles('project-1', 'user-1'),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.composer.profiles).toEqual([PROFILE]));

    mocks.listAgentProfiles.mockResolvedValue([PROFILE, created]);

    await act(async () => {
      await result.current.composer.createProfile({ name: 'Fixer' } as never);
    });

    await waitFor(() => {
      expect(result.current.profilesPage.profiles).toHaveLength(2);
    });
    expect(result.current.profilesPage.profiles.map((p) => p.id)).toContain('profile-2');
  });

  /**
   * Regression: the create path must make the new profile readable from the shared
   * cache the moment `createProfile` resolves — before any refetch lands.
   *
   * `useProjectChatState` selects the returned profile id immediately, and then
   * reconciles that selection against the cached list (`selectProfileId` keeps the
   * current id only if the list contains it, else falls back to the first entry).
   * With invalidate-only, the list is still the pre-mutation one during the
   * read-after-write window, so the brand new selection was discarded. Seeding the
   * server-confirmed row closes that window.
   */
  it('exposes the created profile from the cache before the refetch resolves', async () => {
    const { client, Wrapper } = createWrapper();
    const created = { ...PROFILE, id: 'profile-2', name: 'Fixer' };
    mocks.createAgentProfile.mockResolvedValue(created);

    const { result } = renderHook(() => useAgentProfiles('project-1', 'user-1'), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.profiles).toEqual([PROFILE]));

    // The refetch triggered by the invalidate never settles during this assertion.
    mocks.listAgentProfiles.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      await result.current.createProfile({ name: 'Fixer' } as never);
    });

    const cached = client.getQueryData<typeof created[]>([
      'auth',
      'user-1',
      'agents',
      'profiles',
      'project-1',
    ]);
    expect(cached?.map((p) => p.id)).toContain('profile-2');
  });

  it('propagates an update to every consumer', async () => {
    const { Wrapper } = createWrapper();
    mocks.updateAgentProfile.mockResolvedValue({ ...PROFILE, name: 'Edited' });

    const { result } = renderHook(
      () => ({
        composer: useAgentProfiles('project-1', 'user-1'),
        profilesPage: useAgentProfiles('project-1', 'user-1'),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.composer.profiles).toEqual([PROFILE]));

    mocks.listAgentProfiles.mockResolvedValue([{ ...PROFILE, name: 'Edited' }]);

    await act(async () => {
      await result.current.composer.updateProfile('profile-1', { name: 'Edited' } as never);
    });

    await waitFor(() => expect(result.current.profilesPage.profiles[0]?.name).toBe('Edited'));
  });

  it('propagates a delete to every consumer', async () => {
    const { Wrapper } = createWrapper();
    mocks.deleteAgentProfile.mockResolvedValue(undefined);

    const { result } = renderHook(
      () => ({
        composer: useAgentProfiles('project-1', 'user-1'),
        profilesPage: useAgentProfiles('project-1', 'user-1'),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(result.current.composer.profiles).toEqual([PROFILE]));

    mocks.listAgentProfiles.mockResolvedValue([]);

    await act(async () => {
      await result.current.composer.deleteProfile('profile-1');
    });

    await waitFor(() => expect(result.current.profilesPage.profiles).toEqual([]));
  });

  it('isolates the same project between two authenticated identities', async () => {
    const { client, Wrapper } = createWrapper();
    mocks.listAgentProfiles
      .mockResolvedValueOnce([{ ...PROFILE, name: 'User one profile' }])
      .mockResolvedValueOnce([{ ...PROFILE, name: 'User two profile' }]);

    const { result } = renderHook(
      () => ({
        userOne: useAgentProfiles('project-1', 'user-1'),
        userTwo: useAgentProfiles('project-1', 'user-2'),
      }),
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(result.current.userOne.profiles[0]?.name).toBe('User one profile');
      expect(result.current.userTwo.profiles[0]?.name).toBe('User two profile');
    });
    expect(
      client.getQueryData(['auth', 'user-1', 'agents', 'profiles', 'project-1'])
    ).toBeDefined();
    expect(
      client.getQueryData(['auth', 'user-2', 'agents', 'profiles', 'project-1'])
    ).toBeDefined();
  });

  it('issues no request without a project id or a scope', async () => {
    const { Wrapper } = createWrapper();
    renderHook(
      () => ({
        noProject: useAgentProfiles(undefined, 'user-1'),
        noScope: useAgentProfiles('project-1', ''),
      }),
      { wrapper: Wrapper }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.listAgentProfiles).not.toHaveBeenCalled();
  });
});
