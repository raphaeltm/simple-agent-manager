import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTrial: vi.fn(),
  joinWaitlist: vi.fn(),
  openTrialEventStream: vi.fn(),
}));

vi.mock('../../src/lib/trial-api', () => ({
  createTrial: mocks.createTrial,
  joinWaitlist: mocks.joinWaitlist,
  openTrialEventStream: mocks.openTrialEventStream,
  trialErrorMessage: (code: string) => `message:${code}`,
}));

import { Try } from '../../src/pages/Try';
import { TryCapExceeded } from '../../src/pages/TryCapExceeded';

function renderAt(initialEntries: string[], children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/try" element={children} />
        <Route path="/try/cap-exceeded" element={<TryCapExceeded />} />
        <Route path="/try/waitlist/thanks" element={<div>thanks-page</div>} />
        <Route path="/try/:trialId" element={<div data-testid="trial-page">trial-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Try (landing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty input before calling the API', async () => {
    renderAt(['/try'], <Try />);
    fireEvent.submit(screen.getByRole('button', { name: /explore repo/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/paste a GitHub repo URL/i)).toBeInTheDocument();
    });
    expect(mocks.createTrial).not.toHaveBeenCalled();
  });

  it('rejects a non-GitHub URL with inline error', async () => {
    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://example.com/foo/bar' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/doesn.?t look like a GitHub URL/i)).toBeInTheDocument();
    });
    expect(mocks.createTrial).not.toHaveBeenCalled();
  });

  it('navigates to /try/:trialId on success', async () => {
    mocks.createTrial.mockResolvedValue({
      ok: true,
      value: {
        trialId: 'trial_123',
        projectId: 'proj_123',
        eventsUrl: '/api/trial/trial_123/events',
        expiresAt: '2026-04-19T00:00:00Z',
      },
    });

    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://github.com/simple-agent-manager/demo' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('trial-page')).toBeInTheDocument();
    });
    expect(mocks.createTrial).toHaveBeenCalledWith(
      'https://github.com/simple-agent-manager/demo',
    );
  });

  it('redirects to existing trial when one is already running', async () => {
    mocks.createTrial.mockResolvedValue({
      ok: true,
      existing: { trialId: 'trial_existing', projectId: 'proj_existing' },
    });

    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://github.com/acme/test' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('trial-page')).toBeInTheDocument();
    });
  });

  it('renders TrialsPausedPanel when trials_disabled', async () => {
    mocks.createTrial.mockResolvedValue({
      ok: false,
      error: { error: 'trials_disabled', message: 'paused' },
    });

    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://github.com/acme/test' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /trials are paused/i })).toBeInTheDocument();
    });
  });

  it('navigates to /try/cap-exceeded with resetsAt when capped', async () => {
    mocks.createTrial.mockResolvedValue({
      ok: false,
      error: {
        error: 'cap_exceeded',
        message: 'capped',
        waitlistResetsAt: '2026-05-01T00:00:00Z',
      },
    });

    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://github.com/acme/test' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /hit our trial cap/i }),
      ).toBeInTheDocument();
    });
  });

  it('renders inline error for repo_private branch', async () => {
    mocks.createTrial.mockResolvedValue({
      ok: false,
      error: { error: 'repo_private', message: 'that repo is private' },
    });

    renderAt(['/try'], <Try />);
    const input = screen.getByPlaceholderText(/github\.com\/owner\/repo/i);
    fireEvent.change(input, { target: { value: 'https://github.com/acme/priv' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/that repo is private/i)).toBeInTheDocument();
    });
  });
});

describe('TryCapExceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows reset date from query param', () => {
    renderAt(
      ['/try/cap-exceeded?resetsAt=2026-05-01T00:00:00Z'],
      <div>unused</div>,
    );
    // "Trials reset on May 1, 2026" — locale-dependent; text appears in both
    // the header copy and the waitlist subtext, so expect at least one.
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
  });

  it('rejects invalid emails before calling API', async () => {
    renderAt(['/try/cap-exceeded'], <div>unused</div>);
    const input = screen.getByPlaceholderText(/you@example\.com/i);
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    });
    expect(mocks.joinWaitlist).not.toHaveBeenCalled();
  });

  it('submits valid email and navigates to thanks', async () => {
    mocks.joinWaitlist.mockResolvedValue({ queued: true, resetsAt: '' });

    renderAt(['/try/cap-exceeded'], <div>unused</div>);
    const input = screen.getByPlaceholderText(/you@example\.com/i);
    fireEvent.change(input, { target: { value: 'ada@example.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('thanks-page')).toBeInTheDocument();
    });
    expect(mocks.joinWaitlist).toHaveBeenCalledWith('ada@example.com');
  });

  it('surfaces waitlist API error inline', async () => {
    mocks.joinWaitlist.mockRejectedValue(new Error('server down'));

    renderAt(['/try/cap-exceeded'], <div>unused</div>);
    const input = screen.getByPlaceholderText(/you@example\.com/i);
    fireEvent.change(input, { target: { value: 'ada@example.com' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText(/server down/i)).toBeInTheDocument();
    });
  });
});
