/**
 * Insights · People tab, rendered (`PeopleBody`): reassign goes through the Inbox client with the
 * chosen target, refreshes the People and Inbox caches, and one hand-on runs at a time; a refusal
 * shows on the row; a failed section reads as unavailable, not zero; private items show no title.
 */
import type { ProjectPeopleResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reassign: vi.fn(),
}));

vi.mock('../../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../../src/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({
    members: [
      {
        userId: 'user-1',
        name: 'Raph',
        email: null,
        avatarUrl: null,
        role: 'owner',
        status: 'active',
      },
      {
        userId: 'user-2',
        name: 'Sam',
        email: null,
        avatarUrl: null,
        role: 'member',
        status: 'active',
      },
    ],
    allMembers: [],
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  reassignInboxTask: mocks.reassign,
}));

import { inboxQueryKeys, insightsQueryKeys } from '../../../../src/lib/query-options';
import { PeopleBody } from '../../../../src/pages/insights/PeopleTab';

const HOUR = 3_600_000;

function item(ref: string, title: string, fields: Record<string, unknown> = {}) {
  return {
    private: false,
    ref,
    title,
    kind: 'task' as const,
    blocking: false,
    claimed: false,
    createdAt: '2026-11-16T00:00:00.000Z',
    ageMs: 9 * HOUR,
    canReassign: true,
    ...fields,
  };
}

function data(overrides: Partial<ProjectPeopleResponse> = {}): ProjectPeopleResponse {
  return {
    projectId: 'p1',
    range: '30d',
    since: '2026-10-17T00:00:00.000Z',
    until: '2026-11-16T12:00:00.000Z',
    waiting: {
      total: 3,
      listed: 10,
      groups: [
        {
          key: 'user-1',
          kind: 'person',
          userId: 'user-1',
          name: 'Raph',
          member: true,
          you: true,
          open: 2,
          blocking: 0,
          oldestAgeMs: 9 * HOUR,
          items: [item('ask:a', 'Book the venue'), item('ask:b', 'Sign the lease')],
        },
        {
          key: 'user-2',
          kind: 'person',
          userId: 'user-2',
          name: 'Sam',
          member: true,
          you: false,
          open: 1,
          blocking: 1,
          oldestAgeMs: 2 * HOUR,
          items: [
            {
              private: true,
              ref: null,
              title: null,
              kind: null,
              blocking: null,
              claimed: null,
              createdAt: '2026-11-16T10:00:00.000Z',
              ageMs: 2 * HOUR,
              canReassign: false,
            },
          ],
        },
      ],
    },
    reviewPickup: { state: 'not_recorded', waiting: 0, recordedSince: null },
    firstPerson: { closed: 4, firstPerson: 3, share: 0.75 },
    unavailable: [],
    generatedAt: '2026-11-16T12:00:00.000Z',
    ...overrides,
  };
}

function renderBody(body: ProjectPeopleResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PeopleBody data={body} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { invalidate };
}

function openForm(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `Reassign ${title}` }));
  return screen.getByRole('form', { name: `Reassign ${title}` });
}

describe('PeopleBody', () => {
  beforeEach(() => {
    mocks.reassign.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands a task on through the Inbox client and refreshes People and the Inbox', async () => {
    mocks.reassign.mockResolvedValue({ ref: 'ask:a', status: 'open', agentNotified: true });
    const { invalidate } = renderBody(data());
    const form = openForm('Book the venue');
    // The viewer already has it, so they are not offered as a target.
    const options = within(form)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Choose who…', 'Sam', 'Back to the team']);
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'user-2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Hand it on' }));
    await waitFor(() =>
      expect(screen.getByTestId('insights-reassign-status')).toHaveTextContent('Handed on to Sam.')
    );
    expect(mocks.reassign).toHaveBeenCalledWith('p1', 'ask:a', { assigneeUserId: 'user-2' });
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(insightsQueryKeys.peopleAll('user-1', 'p1')));
    expect(keys).toContain(JSON.stringify(inboxQueryKeys.all('user-1')));
  });

  it('runs one hand-on at a time', async () => {
    let release: (value: unknown) => void = () => undefined;
    mocks.reassign.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    renderBody(data());
    const first = openForm('Book the venue');
    fireEvent.change(within(first).getByRole('combobox'), { target: { value: 'user-2' } });
    fireEvent.click(within(first).getByRole('button', { name: 'Hand it on' }));
    await waitFor(() => expect(mocks.reassign).toHaveBeenCalledTimes(1));
    const second = openForm('Sign the lease');
    fireEvent.change(within(second).getByRole('combobox'), { target: { value: 'user-2' } });
    // The second submit waits while the first is in flight.
    expect(within(second).getByRole('button', { name: 'Hand it on' })).toBeDisabled();
    fireEvent.submit(second);
    expect(mocks.reassign).toHaveBeenCalledTimes(1);
    await act(async () => release({ ref: 'ask:a', status: 'open', agentNotified: true }));
  });

  it('shows a refusal on the row and keeps the form open', async () => {
    mocks.reassign.mockRejectedValue(new Error('The assignee is not an active project member'));
    renderBody(data());
    const form = openForm('Book the venue');
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: '__team__' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Hand it on' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The assignee is not an active project member'
    );
    expect(mocks.reassign).toHaveBeenCalledWith('p1', 'ask:a', { team: true });
    expect(screen.getByRole('form', { name: 'Reassign Book the venue' })).toBeInTheDocument();
  });

  it('shows a private item by its age only, and offers no reassign without permission', () => {
    renderBody(data());
    const sam = screen.getByTestId('insights-waiting-group-user-2');
    expect(sam).toHaveTextContent('An item you cannot open');
    expect(within(sam).queryByRole('button')).toBeNull();
    // Liveness: the reassignable tasks in the viewer's group do get the control.
    expect(screen.getAllByRole('button', { name: /^Reassign / })).toHaveLength(2);
  });

  it('says a failed section is unavailable rather than showing zero', () => {
    renderBody(data({ unavailable: ['first_person'] }));
    expect(screen.getByText(/could not be loaded: first-person answers/)).toBeInTheDocument();
    expect(screen.getByTestId('insights-tile-first-person')).toHaveTextContent('—');
    // Control: the sections that loaded still show.
    expect(screen.getByTestId('insights-tile-waiting')).toHaveTextContent('3');
  });
});
