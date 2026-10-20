/**
 * The Automation pages driven the way a person uses them: real routes, real clicks, mocked API.
 * Each test asserts what reached the API, so a control that collects input but drops it fails.
 */
import type {
  ProjectEventSubscriptionRecord,
  ProjectSchedule,
  ProjectStandingWatch,
  TriggerResponse,
} from '@simple-agent-manager/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  getTrigger: vi.fn(),
  listTriggerExecutions: vi.fn(),
  listWebhookDeliveries: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  runTrigger: vi.fn(),
  previewWebhookTrigger: vi.fn(),
  rotateWebhookTriggerToken: vi.fn(),
  getProjectMembers: vi.fn(),
  listChatSessions: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn(),
  cleanupStuckExecutions: vi.fn(),
  deleteExecution: vi.fn(),
}));
const events = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  getSchedule: vi.fn(),
  createSchedule: vi.fn(),
  rescheduleSchedule: vi.fn(),
  cancelSchedule: vi.fn(),
  reconcileSchedule: vi.fn(),
  listStandingWatches: vi.fn(),
  getStandingWatch: vi.fn(),
  createStandingWatch: vi.fn(),
  updateStandingWatch: vi.fn(),
  pauseStandingWatch: vi.fn(),
  revokeStandingWatch: vi.fn(),
  listEventSubscriptions: vi.fn(),
  cancelEventSubscription: vi.fn(),
  listEventSubscriptionDeliveries: vi.fn(),
  listEventChannels: vi.fn(),
  getEventChannelHistory: vi.fn(),
}));
const scope = vi.hoisted(() => ({ userId: 'owner' }));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
vi.mock('../../../src/lib/api/triggers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cleanupStuckExecutions: api.cleanupStuckExecutions,
  deleteExecution: api.deleteExecution,
}));
vi.mock('../../../src/lib/project-events-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...events,
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => scope.userId }));

import { QueryClientProvider } from '@tanstack/react-query';

import { ToastProvider } from '../../../src/hooks/useToast';
import { AutomationBehind } from '../../../src/pages/automation/AutomationBehind';
import { AutomationDetail } from '../../../src/pages/automation/AutomationDetail';
import { AutomationEditor } from '../../../src/pages/automation/AutomationEditor';
import { AutomationOverview } from '../../../src/pages/automation/AutomationOverview';
import { VERSION_CONFLICT_TEXT } from '../../../src/pages/automation/errors';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { createTestQueryClient } from '../../test-utils/query-test-utils';

const NOW = Date.now();
const HOUR = 3_600_000;

function trigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    id: 'trg-deps',
    projectId: 'p1',
    userId: 'owner',
    name: 'Dependency audit',
    description: null,
    status: 'paused',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Audit dependencies',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: new Date(NOW - HOUR).toISOString(),
    triggerCount: 3,
    nextFireAt: null,
    createdAt: new Date(NOW - 10 * 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  };
}

const failedRun = (id: string, hoursAgo: number) => ({
  id,
  triggerId: 'trg-deps',
  projectId: 'p1',
  status: 'failed',
  skipReason: null,
  taskId: `task-${id}`,
  eventType: 'cron',
  renderedPrompt: null,
  errorMessage: 'GitHub token expired',
  scheduledAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  completedAt: new Date(NOW - hoursAgo * HOUR + 60_000).toISOString(),
  sequenceNumber: 1,
  createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
});

function watch(overrides: Partial<ProjectStandingWatch> = {}): ProjectStandingWatch {
  return {
    id: 'w1',
    projectId: 'p1',
    creatorUserId: 'someone-else',
    reason: 'Failed releases',
    filter: { version: 1, source: 'sam.lifecycle', eventType: 'deployment.release.failed' },
    action: { kind: 'start_session', prompt: 'Investigate', agentProfileId: null, skillId: null },
    state: 'active',
    version: 5,
    idempotencyKey: 'k',
    cooldownMs: 60_000,
    maxConcurrent: 1,
    maxExecutions: 10,
    executionCount: 10,
    nextEligibleAt: 0,
    subscriptionId: 's1',
    createdAt: NOW - 5 * 24 * HOUR,
    updatedAt: NOW - HOUR,
    lastError: null,
    ...overrides,
  };
}

function schedule(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return {
    id: 'sch-1',
    projectId: 'p1',
    creatorUserId: 'owner',
    creatorChatSessionId: null,
    reason: 'Check the release',
    action: { kind: 'message_session', sessionId: 'chat-1', prompt: 'Is it live?' },
    state: 'pending',
    dueAt: NOW + 2 * HOUR,
    displayTimezone: 'UTC',
    expiresAt: NOW + 26 * HOUR,
    version: 3,
    idempotencyKey: 'k',
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    nextAttemptAt: null,
    attemptCount: 0,
    lastError: null,
    eventId: null,
    deliveryId: null,
    resultTaskId: null,
    resultSessionId: null,
    watchId: null,
    sourceEventId: null,
    ...overrides,
  };
}

function subscription(
  overrides: Partial<ProjectEventSubscriptionRecord>
): ProjectEventSubscriptionRecord {
  return {
    id: 'sub-ci',
    projectId: 'p1',
    contractVersion: 1,
    owner: { type: 'agent', id: 'p1:chat-1', name: '01AGENT' },
    idempotencyKey: 'k',
    filter: {
      version: 1,
      source: 'github',
      eventType: 'check_suite.completed',
      subjectType: 'commit',
      subjectId: 'abcdef1234',
    },
    filterFingerprint: 'f',
    matchKeyCount: 1,
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      target: { sessionId: 'chat-1', taskId: 't', runtimeId: null, agentId: null },
    },
    state: 'active',
    reason: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    lastMatchedAt: null,
    ...overrides,
  } as ProjectEventSubscriptionRecord;
}

function member(userId: string, role: string) {
  return {
    projectId: 'p1',
    userId,
    role,
    status: 'active',
    user: { id: userId, name: userId, email: `${userId}@x.test` },
  };
}

function Where() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function Shell({ children }: { children?: ReactNode }) {
  const [value] = useState(() => ({
    projectId: 'p1',
    project: { id: 'p1', userId: 'owner', name: 'Project' } as never,
    installations: [],
    reload: async () => undefined,
  }));
  return (
    <ProjectContext.Provider value={value}>
      {children ?? <Outlet />}
      <Where />
    </ProjectContext.Provider>
  );
}

/** The same automation routes App.tsx declares, under a project route that owns `:id`. */
function renderAt(path: string) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/projects/:id" element={<Shell />}>
              <Route path="automation" element={<AutomationOverview />} />
              <Route path="automation/new" element={<AutomationEditor />} />
              <Route path="automation/behind" element={<AutomationBehind />} />
              <Route path="automation/:kind/:automationId" element={<AutomationDetail />} />
              <Route path="automation/:kind/:automationId/edit" element={<AutomationEditor />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  scope.userId = 'owner';
  api.listTriggers.mockResolvedValue({ triggers: [] });
  api.listTriggerExecutions.mockResolvedValue({ executions: [], nextCursor: null });
  api.listWebhookDeliveries.mockResolvedValue({ deliveries: [], nextCursor: null });
  api.getProjectMembers.mockResolvedValue({
    members: [member('owner', 'owner'), member('viewer', 'viewer')],
  });
  api.listChatSessions.mockResolvedValue({
    sessions: [{ id: 'chat-1', topic: 'Release shepherd', status: 'active' }],
    total: 1,
  });
  api.listAgentProfiles.mockResolvedValue([
    { id: 'prof-1', name: 'Codex', model: 'gpt-5.5', effort: 'auto' },
  ]);
  api.listSkills.mockResolvedValue([]);
  events.listSchedules.mockResolvedValue({ schedules: [], nextCursor: null });
  events.listStandingWatches.mockResolvedValue({ watches: [], nextCursor: null });
  events.listEventSubscriptions.mockResolvedValue({ subscriptions: [], hasMore: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('overview', () => {
  it('resumes a trigger SAM paused after failures, from its attention card', async () => {
    const paused = trigger();
    api.listTriggers.mockResolvedValue({ triggers: [paused] });
    api.listTriggerExecutions.mockResolvedValue({
      executions: [failedRun('r3', 1), failedRun('r2', 25), failedRun('r1', 49)],
      nextCursor: null,
    });
    api.updateTrigger.mockResolvedValue({ ...paused, status: 'active' });
    renderAt('/projects/p1/automation');
    const card = await screen.findByRole('region', { name: 'Dependency audit' });
    expect(within(card).getByText('Paused · its last 3 runs failed')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(api.updateTrigger).toHaveBeenCalledWith('p1', 'trg-deps', { status: 'active' })
    );
  });

  it('shows a viewer everything but no controls', async () => {
    scope.userId = 'viewer';
    api.listTriggers.mockResolvedValue({ triggers: [trigger()] });
    api.listTriggerExecutions.mockResolvedValue({
      executions: [failedRun('r3', 1), failedRun('r2', 25), failedRun('r1', 49)],
      nextCursor: null,
    });
    renderAt('/projects/p1/automation');
    expect(
      await screen.findByText(/Only people who can edit this project can change automation/)
    ).toBeInTheDocument();
    expect(screen.getAllByText('Dependency audit').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /New automation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });
});

describe('create flow', () => {
  it('opens the create flow at /automation/new even though the project route owns :id', async () => {
    renderAt('/projects/p1/automation/new');
    expect(await screen.findByText(/Step 1 of 4/)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/automation/new');
  });

  it('creates a webhook automation and shows its token once', async () => {
    const user = userEvent.setup();
    api.createTrigger.mockResolvedValue({
      ...trigger({ id: 'trg-new', sourceType: 'webhook', status: 'active' }),
      webhookCredential: {
        endpointUrl: 'https://api.example.test/api/webhooks/ingest',
        token: 'secret-token',
        headerName: 'Authorization',
      },
    });
    renderAt('/projects/p1/automation/new');
    await user.click(await screen.findByRole('radio', { name: /When another service calls SAM/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText(/Source label/), 'PagerDuty');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText('Webhook automations need an agent profile.')
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Agent'), 'prof-1');
    await user.type(screen.getByLabelText('What should it do?'), 'Look into the alert');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Alerts');
    // Overlap controls apply to every trigger kind, not only schedules.
    await user.click(screen.getByText('Advanced options'));
    await user.click(screen.getByRole('checkbox', { name: /Skip a run if the last one/ }));
    await user.clear(screen.getByLabelText('Most runs at once'));
    await user.type(screen.getByLabelText('Most runs at once'), '3');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() =>
      expect(api.createTrigger).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          name: 'Alerts',
          sourceType: 'webhook',
          agentProfileId: 'prof-1',
          skipIfRunning: false,
          maxConcurrent: 3,
          promptTemplate: 'Look into the alert',
          webhookConfig: expect.objectContaining({
            sourceLabel: 'PagerDuty',
            filterMode: 'all',
            filters: [],
          }),
        })
      )
    );
    expect(await screen.findByText('Save your webhook credential')).toBeInTheDocument();
    expect(screen.getByText('secret-token')).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I saved this token/));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/projects/p1/automation/trigger/trg-new'
      )
    );
  });

  it('reminds a chat later with a one-time message to that chat', async () => {
    const user = userEvent.setup();
    events.createSchedule.mockResolvedValue({
      schedule: schedule({ id: 'sch-new' }),
      changed: true,
      idempotent: false,
      actionAlreadyAdmitted: false,
    });
    renderAt('/projects/p1/automation/new?sessionId=chat-1');
    expect(await screen.findByText(/Step 2 of 4/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('radio', { name: /Message a chat/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await waitFor(() => expect(screen.getByLabelText('Which chat?')).toHaveValue('chat-1'));
    await user.type(screen.getByLabelText('What should the message say?'), 'Check the deploy');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create automation' }));
    await waitFor(() => expect(events.createSchedule).toHaveBeenCalledTimes(1));
    const [, body] = events.createSchedule.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      action: { kind: 'message_session', sessionId: 'chat-1', prompt: 'Check the deploy' },
      displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(body.dueAt).toBeGreaterThan(Date.now());
    expect(body.expiresAt).toBeGreaterThan(body.dueAt);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/automation/schedule/sch-new')
    );
  });
});

describe('choosing a chat to message', () => {
  const sessions = [
    { id: 'chat-mine', topic: 'My release chat', status: 'active', isMine: true },
    { id: 'chat-theirs', topic: 'Teammate chat', status: 'active', isMine: false },
  ];

  it('offers a watch only the chats its creator owns', async () => {
    const user = userEvent.setup();
    api.listChatSessions.mockResolvedValue({ sessions, total: sessions.length });
    renderAt('/projects/p1/automation/new?start=event');
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('radio', { name: /Message a chat/ }));
    const picker = screen.getByLabelText('Which chat?');
    expect(within(picker).getByRole('option', { name: 'My release chat' })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: 'Teammate chat' })).toBeNull();
  });

  it('offers a one-time message every listed chat, since shared chats qualify too', async () => {
    const user = userEvent.setup();
    api.listChatSessions.mockResolvedValue({ sessions, total: sessions.length });
    renderAt('/projects/p1/automation/new?start=once');
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('radio', { name: /Message a chat/ }));
    const picker = screen.getByLabelText('Which chat?');
    expect(within(picker).getByRole('option', { name: 'My release chat' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Teammate chat' })).toBeInTheDocument();
  });
});

describe('editing a trigger', () => {
  it('opens on the schedule that was saved, not a default', async () => {
    api.getTrigger.mockResolvedValue(
      trigger({ status: 'active', cronExpression: '30 2 * * *', cronTimezone: 'Europe/Paris' })
    );
    renderAt('/projects/p1/automation/trigger/trg-deps/edit');
    expect(await screen.findByRole('radio', { name: 'Every day' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByLabelText('At')).toHaveValue('02:30');
    expect(screen.getByLabelText('Time zone')).toHaveValue('Europe/Paris');
  });
});

describe('watches', () => {
  it('lets a maintainer edit a watch someone else made without changing what it does', async () => {
    const user = userEvent.setup();
    const existing = watch({ executionCount: 2 });
    events.getStandingWatch.mockResolvedValue({ watch: existing });
    events.updateStandingWatch.mockResolvedValue({
      watch: existing,
      changed: true,
      idempotent: false,
    });
    renderAt('/projects/p1/automation/watch/w1/edit');
    expect(await screen.findByText(/Step 1 of 3/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/can change what this watch does/)).toBeInTheDocument();
    expect(screen.queryByLabelText('What should it do?')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(events.updateStandingWatch).toHaveBeenCalledTimes(1));
    const [, , body] = events.updateStandingWatch.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty('action');
    expect(body).toMatchObject({ expectedVersion: 5, filter: existing.filter, maxExecutions: 10 });
  });

  it('raises the run limit with only the limit', async () => {
    const user = userEvent.setup();
    events.getStandingWatch.mockResolvedValue({ watch: watch() });
    events.updateStandingWatch.mockResolvedValue({
      watch: watch({ maxExecutions: 20 }),
      changed: true,
      idempotent: false,
    });
    renderAt('/projects/p1/automation/watch/w1');
    await user.click(await screen.findByRole('button', { name: 'Give it more runs' }));
    const dialog = await screen.findByRole('dialog', { name: 'Give it more runs' });
    const input = within(dialog).getByLabelText('Total runs it may start');
    await user.clear(input);
    await user.type(input, '25');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    await waitFor(() =>
      expect(events.updateStandingWatch).toHaveBeenCalledWith('p1', 'w1', {
        expectedVersion: 5,
        maxExecutions: 25,
      })
    );
  });
});

describe('trigger page', () => {
  it('deletes only after confirming, then returns to the overview', async () => {
    const user = userEvent.setup();
    const existing = trigger({ status: 'active' });
    api.getTrigger.mockResolvedValue(existing);
    api.deleteTrigger.mockResolvedValue({ success: true });
    renderAt('/projects/p1/automation/trigger/trg-deps');
    await user.click(await screen.findByRole('button', { name: 'Delete automation' }));
    expect(api.deleteTrigger).not.toHaveBeenCalled();
    expect(
      screen.getByText(/permanently deletes “Dependency audit” and all its run history/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteTrigger).toHaveBeenCalledWith('p1', 'trg-deps'));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/projects\/p1\/automation$/)
    );
  });

  it('replaces a webhook token only after confirming, and shows the new one once', async () => {
    const user = userEvent.setup();
    api.getTrigger.mockResolvedValue(
      trigger({
        id: 'trg-hook',
        status: 'active',
        sourceType: 'webhook',
        cronExpression: null,
        webhookConfig: {
          sourceLabel: 'CI',
          filterMode: 'all',
          filters: [],
          includedHeaders: [],
          tokenLastFour: 'abcd',
          tokenCreatedAt: new Date(NOW).toISOString(),
          tokenRotatedAt: null,
        },
      })
    );
    api.rotateWebhookTriggerToken.mockResolvedValue({
      webhookCredential: {
        endpointUrl: 'https://api.example.test/api/webhooks/ingest',
        token: 'fresh-token',
        headerName: 'Authorization',
      },
    });
    renderAt('/projects/p1/automation/trigger/trg-hook');
    expect(await screen.findByTestId('webhook-url')).toHaveTextContent('/api/webhooks/ingest');
    await user.click(screen.getByRole('button', { name: /Get a new token/ }));
    expect(api.rotateWebhookTriggerToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText('fresh-token')).toBeInTheDocument();
    expect(api.rotateWebhookTriggerToken).toHaveBeenCalledWith('p1', 'trg-hook');
  });

  it('says what each webhook call did with its run', async () => {
    api.getTrigger.mockResolvedValue(
      trigger({
        id: 'trg-hook',
        status: 'active',
        sourceType: 'webhook',
        cronExpression: null,
        webhookConfig: {
          sourceLabel: 'CI',
          filterMode: 'all',
          filters: [],
          includedHeaders: [],
          tokenLastFour: 'abcd',
          tokenCreatedAt: new Date(NOW).toISOString(),
          tokenRotatedAt: null,
        },
      })
    );
    const call = (id: string, outcome: string, executionId: string | null) => ({
      id,
      triggerId: 'trg-hook',
      outcome,
      httpStatus: 202,
      bodyBytes: 120,
      executionId,
      errorCode: null,
      receivedAt: new Date(NOW - HOUR).toISOString(),
      processedAt: new Date(NOW - HOUR).toISOString(),
    });
    api.listWebhookDeliveries.mockResolvedValue({
      deliveries: [
        call('d1', 'accepted', 'exec-started'),
        call('d2', 'still_running', 'exec-skip-record'),
        call('d3', 'filtered', null),
      ],
      nextCursor: null,
    });
    renderAt('/projects/p1/automation/trigger/trg-hook');
    const calls = await screen.findByRole('region', { name: 'Calls received' });
    expect(
      await within(calls).findByText('Started a run, listed under Recent runs')
    ).toHaveAttribute('title', 'Run ID exec-started');
    expect(
      within(calls).getByText('Recorded as a skipped run, listed under Recent runs')
    ).toBeInTheDocument();
    expect(within(calls).getByText('Ignored: did not match the filters')).toBeInTheDocument();
    expect(within(calls).getAllByText(/listed under Recent runs/)).toHaveLength(2);
  });

  it('never offers run now for an incident trigger', async () => {
    api.getTrigger.mockResolvedValue(
      trigger({ id: 'trg-inc', status: 'active', sourceType: 'incident', cronExpression: null })
    );
    renderAt('/projects/p1/automation/trigger/trg-inc');
    expect(await screen.findByText(/cannot be run by hand/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run now/ })).not.toBeInTheDocument();
  });
});

describe('one-time automation page', () => {
  it('cancels with a reason after confirming', async () => {
    const user = userEvent.setup();
    events.getSchedule.mockResolvedValue({ schedule: schedule() });
    events.cancelSchedule.mockResolvedValue({
      schedule: schedule({ state: 'cancelled' }),
      changed: true,
      idempotent: false,
      actionAlreadyAdmitted: false,
    });
    renderAt('/projects/p1/automation/schedule/sch-1');
    await user.click(await screen.findByRole('button', { name: /Cancel/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Why/), 'Release moved');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel it' }));
    await waitFor(() =>
      expect(events.cancelSchedule).toHaveBeenCalledWith('p1', 'sch-1', {
        expectedVersion: 3,
        reason: 'Release moved',
      })
    );
  });
});

describe('someone else changed it first', () => {
  it('says so in words, loads the latest, and retries with the new version', async () => {
    const user = userEvent.setup();
    events.getSchedule
      .mockResolvedValueOnce({ schedule: schedule({ version: 3 }) })
      .mockResolvedValue({ schedule: schedule({ version: 4 }) });
    events.cancelSchedule
      .mockRejectedValueOnce(new Error('Schedule version conflict'))
      .mockResolvedValue({
        schedule: schedule({ state: 'cancelled', version: 5 }),
        changed: true,
        idempotent: false,
        actionAlreadyAdmitted: false,
      });
    renderAt('/projects/p1/automation/schedule/sch-1');
    const cancelOnce = async () => {
      await user.click(await screen.findByRole('button', { name: /Cancel/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel it' }));
    };
    await cancelOnce();
    expect(await screen.findByText(VERSION_CONFLICT_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('Schedule version conflict')).not.toBeInTheDocument();
    await waitFor(() => expect(events.getSchedule).toHaveBeenCalledTimes(2));
    await cancelOnce();
    await waitFor(() =>
      expect(events.cancelSchedule).toHaveBeenLastCalledWith(
        'p1',
        'sch-1',
        expect.objectContaining({ expectedVersion: 4 })
      )
    );
  });
});

describe('behind the scenes', () => {
  it('hides SAM relays until asked, and lets people stop only waits they may stop', async () => {
    const user = userEvent.setup();
    events.listEventSubscriptions.mockResolvedValue({
      subscriptions: [
        subscription({}),
        subscription({
          id: 'sub-relay',
          owner: { type: 'agent', id: 'p1:chat-1', name: 'SAM agent messaging' },
          filter: {
            version: 1,
            source: 'sam.agent_channel',
            eventType: 'agent.channel.published',
            subjectType: 'agent_channel',
            subjectId: 'agent-dm.0123456789abcdef0123456789abcdef01234567',
          },
        }),
        subscription({
          id: 'sub-watch',
          owner: { type: 'standing_watch', id: 'w1', name: null },
          filter: { version: 1, source: 'sam.lifecycle', eventType: 'deployment.release.failed' },
          deliveryPreference: { requested: 'spawn_task', resolved: 'spawn_task', target: {} },
        }),
      ],
      hasMore: false,
    });
    events.cancelEventSubscription.mockResolvedValue({});
    renderAt('/projects/p1/automation/behind');
    expect(
      await screen.findByText(/Release shepherd is waiting for CI to finish on commit abcdef1/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/SAM manages this relay/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Stop waiting' })).toHaveLength(1);
    await user.click(screen.getByLabelText(/Show SAM’s own message relays \(1\)/));
    expect(await screen.findByText(/SAM manages this relay/)).toBeInTheDocument();
    // The relay is shown but still cannot be stopped; neither can the watch's own wait.
    expect(screen.getAllByRole('button', { name: 'Stop waiting' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop waiting' })
    );
    await waitFor(() =>
      expect(events.cancelEventSubscription).toHaveBeenCalledWith('p1', 'sub-ci', undefined)
    );
  });
});
