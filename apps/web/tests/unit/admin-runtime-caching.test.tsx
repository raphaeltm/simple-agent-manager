import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scope: 'user-a',
  runtime: vi.fn(),
  platform: vi.fn(),
  projects: vi.fn(),
  connector: vi.fn(),
  email: vi.fn(),
  trials: vi.fn(),
}));
vi.mock('../../src/hooks/useQueryScope', () => ({ useQueryScope: () => mocks.scope }));
vi.mock('../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/lib/api', async (original) => ({
  ...(await original<typeof import('../../src/lib/api')>()),
  getProjectRuntimeConfig: mocks.runtime,
  fetchAdminPlatformConfig: mocks.platform,
  listProjects: mocks.projects,
  fetchAdminTrialsConfig: mocks.trials,
}));
vi.mock('../../src/components/AdminConnectorPanel', () => ({
  AdminConnectorPanel: () => {
    mocks.connector();
    return <div>Connector panel</div>;
  },
}));
vi.mock('../../src/components/AdminAgentEmailPanel', () => ({
  AdminAgentEmailPanel: () => {
    mocks.email();
    return <div>Email panel</div>;
  },
}));
import { ProjectRuntimeConfigSection } from '../../src/components/project-settings/ProjectRuntimeConfigSection';
import { AdminPlatformConfig } from '../../src/pages/AdminPlatformConfig';
import { AdminTrials } from '../../src/pages/AdminTrials';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
  });
  const view = (child: React.ReactNode) => (
    <QueryClientProvider client={client}>{child}</QueryClientProvider>
  );
  return { client, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = 'user-a';
  mocks.projects.mockResolvedValue({ projects: [] });
});
describe('cached admin and Runtime navigation', () => {
  it('renders Runtime data immediately on revisit while refreshing, and isolates identities', async () => {
    mocks.runtime.mockResolvedValueOnce({
      envVars: [{ key: 'VISIBLE_KEY', value: 'cached', isSecret: false }],
      files: [],
    });
    const refresh = deferred<never>();
    mocks.runtime.mockReturnValueOnce(refresh.promise);
    const { view } = harness();
    const rendered = render(view(<ProjectRuntimeConfigSection projectId="project-a" />));
    await screen.findByText('VISIBLE_KEY');
    rendered.rerender(view(null));
    rendered.rerender(view(<ProjectRuntimeConfigSection projectId="project-a" />));
    expect(screen.getByText('VISIBLE_KEY')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.runtime).toHaveBeenCalledTimes(2));
    mocks.scope = 'user-b';
    mocks.runtime.mockReturnValue(new Promise(() => undefined));
    rendered.rerender(view(<ProjectRuntimeConfigSection projectId="project-a" />));
    expect(screen.queryByText('VISIBLE_KEY')).not.toBeInTheDocument();
  });

  it('mounts Integrations panels while platform config is still pending', async () => {
    mocks.platform.mockReturnValue(new Promise(() => undefined));
    const { view } = harness();
    render(view(<AdminPlatformConfig />));
    expect(screen.getByText('Connector panel')).toBeInTheDocument();
    expect(screen.getByText('Email panel')).toBeInTheDocument();
    await waitFor(() => expect(mocks.platform).toHaveBeenCalledTimes(1));
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it('aborts the Runtime network read when its last observer leaves', async () => {
    let signal: AbortSignal | undefined;
    mocks.runtime.mockImplementation((_id, callerSignal) => {
      signal = callerSignal;
      return new Promise(() => undefined);
    });
    const { view } = harness();
    const rendered = render(view(<ProjectRuntimeConfigSection projectId="project-a" />));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    await act(async () => rendered.unmount());
    expect(signal!.aborted).toBe(true);
  });
});

it('renders cached admin content immediately after leaving and revisiting the tab', async () => {
  mocks.trials.mockResolvedValueOnce({ enabled: true });
  const { view } = harness();
  const rendered = render(view(<AdminTrials />));
  await screen.findByRole('button', { name: 'Pause trials' });
  rendered.rerender(view(null));
  mocks.trials.mockReturnValue(new Promise(() => undefined));
  rendered.rerender(view(<AdminTrials />));
  expect(screen.getByRole('button', { name: 'Pause trials' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await waitFor(() => expect(mocks.trials).toHaveBeenCalledTimes(2));
});
