import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FeedbackProjectStatus,
  PlatformConfigStatus,
  PlatformIntegrationStatus,
} from '../../src/lib/api';

const mocks = vi.hoisted(() => ({
  scope: 'user-a',
  quotas: vi.fn(),
  updateQuota: vi.fn(),
  runtime: vi.fn(),
  platform: vi.fn(),
  projects: vi.fn(),
  connector: vi.fn(),
  email: vi.fn(),
  trials: vi.fn(),
  deleteEnv: vi.fn(),
  usage: vi.fn(),
  userUsage: vi.fn(),
  trends: vi.fn(),
}));
vi.mock('../../src/hooks/useQueryScope', () => ({ useQueryScope: () => mocks.scope }));
vi.mock('../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/lib/api', async (original) => ({
  ...(await original<typeof import('../../src/lib/api')>()),
  getProjectRuntimeConfig: mocks.runtime,
  deleteProjectRuntimeEnvVar: mocks.deleteEnv,
  fetchAdminUserQuotas: mocks.quotas,
  updateAdminDefaultQuota: mocks.updateQuota,
  fetchAdminNodeUsage: mocks.usage,
  fetchAdminUserNodeUsage: mocks.userUsage,
  fetchAdminErrorTrends: mocks.trends,
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
import { ErrorTrends } from '../../src/components/admin/ErrorTrends';
import { ProjectRuntimeConfigSection } from '../../src/components/project-settings/ProjectRuntimeConfigSection';
import { projectQueryKeys } from '../../src/lib/query-options/projects';
import { AdminComputeQuotas } from '../../src/pages/AdminComputeQuotas';
import { AdminComputeUsage, UserDetail } from '../../src/pages/AdminComputeUsage';
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

it('does not let an older Runtime refresh resurrect a deleted variable', async () => {
  const old = { envVars: [{ key: 'OLD_KEY', value: 'cached', isSecret: false }], files: [] };
  const refresh = deferred<typeof old>();
  mocks.runtime.mockReturnValue(refresh.promise);
  mocks.deleteEnv.mockResolvedValue({ envVars: [], files: [] });
  const { client, view } = harness();
  client.setQueryData(projectQueryKeys.runtimeConfig('user-a', 'project-a'), old);
  render(view(<ProjectRuntimeConfigSection projectId="project-a" />));
  await waitFor(() => expect(mocks.runtime).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Remove OLD_KEY' }));
  await waitFor(() => expect(screen.queryByText('OLD_KEY')).not.toBeInTheDocument());
  await act(async () => refresh.resolve(old));
  expect(screen.queryByText('OLD_KEY')).not.toBeInTheDocument();
  expect(client.getQueryData(projectQueryKeys.runtimeConfig('user-a', 'project-a'))).toEqual({
    envVars: [],
    files: [],
  });
});

it('removes previous identity error trends while the next identity is pending', async () => {
  mocks.trends.mockResolvedValueOnce({
    range: '24h',
    interval: '1h',
    buckets: [
      {
        timestamp: '2026-10-30T00:00:00Z',
        total: 42,
        bySource: { api: 42 },
      },
    ],
  });
  const { view } = harness();
  const rendered = render(view(<ErrorTrends />));
  await screen.findByTestId('trend-chart');
  mocks.scope = 'user-b';
  mocks.trends.mockReturnValue(new Promise(() => undefined));
  rendered.rerender(view(<ErrorTrends />));
  expect(screen.queryByTestId('trend-chart')).not.toBeInTheDocument();
  await waitFor(() => expect(mocks.trends).toHaveBeenCalledTimes(2));
});

it('retains cached Usage list and detail, with Back available after refresh failures', async () => {
  const { client, view } = harness();
  client.setQueryData(['auth', 'user-a', 'admin', 'AdminComputeUsage', null], {
    users: [],
    period: { start: '2026-10-01', end: '2026-11-01' },
  });
  mocks.usage.mockRejectedValue(new Error('List refresh unavailable'));
  const rendered = render(view(<AdminComputeUsage />));
  await screen.findByText('Refresh failed: List refresh unavailable');
  expect(screen.getByText('No node usage this period.')).toBeInTheDocument();
  client.setQueryData(['auth', 'user-a', 'admin', 'node-usage', 'target'], {
    nodes: [],
    totalNodeHours: 2,
    totalVcpuHours: 4,
    activeNodes: 0,
    platformNodeHours: 2,
  });
  mocks.userUsage.mockRejectedValue(new Error('Detail refresh unavailable'));
  const back = vi.fn();
  rendered.rerender(view(<UserDetail userId="target" onBack={back} />));
  await screen.findByText('Refresh failed: Detail refresh unavailable');
  expect(screen.getByText('No nodes this period.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to all users' }));
  expect(back).toHaveBeenCalledOnce();
});

function integration(
  fields: string[],
  overrides: Partial<PlatformIntegrationStatus> = {}
): PlatformIntegrationStatus {
  return {
    configured: false,
    source: 'unset',
    label: 'not configured',
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      ])
    ),
    ...overrides,
  };
}

function makeStatus(
  infrastructure: PlatformIntegrationStatus = integration(['clientId', 'clientSecret']),
  feedbackProject: FeedbackProjectStatus = {
    configured: false,
    source: 'unset',
    label: 'not configured',
    state: 'unset',
    projectId: null,
    project: null,
    message: 'No feedback project is configured.',
    fields: {
      projectId: { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
    },
  }
): PlatformConfigStatus {
  return {
    setupCompleted: true,
    setupForced: false,
    integrations: {
      githubOAuth: integration(['clientId', 'clientSecret']),
      githubApp: integration(['appId', 'appPrivateKey', 'appSlug']),
      githubWebhook: integration(['webhookSecret']),
      googleOAuth: integration(['clientId', 'clientSecret']),
      googleInfrastructureOAuth: infrastructure,
      gitlabOAuth: integration(['host', 'clientId', 'clientSecret']),
    },
    feedbackProject,
  };
}

it('loads feedback project pages only on demand and keeps the form visible', async () => {
  mocks.platform.mockResolvedValue({ status: makeStatus() });
  mocks.projects.mockResolvedValueOnce({
    projects: [{ id: 'first', name: 'First project' }],
    nextCursor: 'next',
  });
  const next = deferred<{ projects: { id: string; name: string }[] }>();
  mocks.projects.mockReturnValueOnce(next.promise);
  const { view } = harness();
  render(view(<AdminPlatformConfig />));
  await screen.findByRole('option', { name: /First project/ });
  expect(mocks.projects).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
  await waitFor(() => expect(mocks.projects).toHaveBeenCalledTimes(2));
  expect(mocks.projects.mock.calls[1][1]).toBe('next');
  expect(screen.getByRole('button', { name: 'Save integrations' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /First project/ })).toBeInTheDocument();
  await act(async () => next.resolve({ projects: [{ id: 'later', name: 'Later project' }] }));
  expect(await screen.findByRole('option', { name: /Later project/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more projects' })).not.toBeInTheDocument();
});

it('retries the first feedback project page without remounting the integration form', async () => {
  mocks.platform.mockResolvedValue({ status: makeStatus() });
  mocks.projects
    .mockRejectedValueOnce(new Error('Projects unavailable'))
    .mockResolvedValueOnce({ projects: [{ id: 'recovered', name: 'Recovered project' }] });
  const { view } = harness();
  render(view(<AdminPlatformConfig />));
  await screen.findByText('Projects unavailable');
  const formButton = screen.getByRole('button', { name: 'Save integrations' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry project list' }));
  await screen.findByRole('option', { name: /Recovered project/ });
  expect(screen.getByRole('button', { name: 'Save integrations' })).toBe(formButton);
  expect(mocks.projects).toHaveBeenCalledTimes(2);
});

it('clears an old quota action error after a successful corrected save without a spinner', async () => {
  mocks.quotas.mockResolvedValue({ defaultQuota: { monthlyVcpuHoursLimit: null }, users: [] });
  mocks.updateQuota
    .mockRejectedValueOnce(new Error('Quota save unavailable'))
    .mockResolvedValueOnce({});
  const { view } = harness();
  render(view(<AdminComputeQuotas />));
  fireEvent.click(await screen.findByRole('button', { name: 'Save', exact: true }));
  await screen.findByText('Quota save unavailable');
  fireEvent.change(screen.getByLabelText('Monthly vCPU-hours limit'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(mocks.updateQuota).toHaveBeenLastCalledWith(10));
  await waitFor(() => expect(screen.queryByText('Quota save unavailable')).not.toBeInTheDocument());
  expect(screen.getByText('Default Quota')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
