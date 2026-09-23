import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../src/hooks/useToast';
import { renderWithQuery } from '../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  fetchAdminProjectDataArchiveCircuitBreakers: vi.fn(),
  fetchAdminProjectDataStorageTelemetry: vi.fn(),
  closeAdminProjectDataArchiveCircuitBreaker: vi.fn(),
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
  }),
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  fetchAdminProjectDataArchiveCircuitBreakers: mocks.fetchAdminProjectDataArchiveCircuitBreakers,
  fetchAdminProjectDataStorageTelemetry: mocks.fetchAdminProjectDataStorageTelemetry,
  closeAdminProjectDataArchiveCircuitBreaker: mocks.closeAdminProjectDataArchiveCircuitBreaker,
}));

import { AdminStorage } from '../../src/pages/AdminStorage';

const OPEN_BREAKER = {
  projectId: 'project-sam',
  projectName: 'SAM',
  repository: 'org/sam',
  state: 'open' as const,
  reason: 'attempts_exhausted:Error',
  openedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

const CLOSED_BREAKER = {
  projectId: 'project-other',
  projectName: 'Other',
  repository: 'org/other',
  state: 'closed' as const,
  reason: 'operator reset',
  openedAt: null,
  updatedAt: 1_700_000_200_000,
};

function Wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

function renderPage() {
  return renderWithQuery(<AdminStorage />, { wrapper: Wrapper });
}

describe('AdminStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminProjectDataArchiveCircuitBreakers.mockResolvedValue({
      breakers: [OPEN_BREAKER, CLOSED_BREAKER],
      skippedRows: 0,
      limit: 25,
    });
    mocks.fetchAdminProjectDataStorageTelemetry.mockResolvedValue({
      telemetry: [
        {
          project_id: 'project-sam',
          project_name: 'SAM',
          repository: 'org/sam',
          measured_at: 1_700_000_100_000,
          database_size_bytes: 10_097_864_704,
          limit_bytes: 10_000_000_000,
          usage_ratio: 1.0097864704,
          status: 'degraded',
          growth_rate_bytes_per_day: 30_925_756,
          estimated_days_to_limit: 0,
          cleanup_health: 'running',
          last_error: null,
          updated_at: 1_700_000_100_000,
        },
      ],
    });
  });

  it('shows the close control only for breakers that are not closed', async () => {
    renderPage();

    const samCard = await screen.findByTestId('breaker-project-sam');
    expect(samCard).toHaveTextContent('attempts_exhausted:Error');
    expect(samCard).toHaveTextContent('Open');
    expect(samCard.querySelector('button')).toHaveTextContent(/close breaker/i);

    const otherCard = screen.getByTestId('breaker-project-other');
    expect(otherCard).toHaveTextContent('Closed');
    expect(otherCard.querySelector('button')).toBeNull();

    // Telemetry section is live alongside the breaker list.
    expect(await screen.findByText(/degraded/)).toBeInTheDocument();
  });

  it('closes a breaker with the entered reason and refetches the list', async () => {
    mocks.closeAdminProjectDataArchiveCircuitBreaker.mockResolvedValue({
      result: {
        projectId: 'project-sam',
        state: 'closed',
        reason: 'fix deployed',
        frozenMigrations: 0,
        frozenLocations: 0,
        updatedAt: 1_700_000_300_000,
        note: null,
      },
    });
    mocks.fetchAdminProjectDataArchiveCircuitBreakers
      .mockResolvedValueOnce({
        breakers: [OPEN_BREAKER, CLOSED_BREAKER],
        skippedRows: 0,
        limit: 25,
      })
      .mockResolvedValue({
        breakers: [{ ...OPEN_BREAKER, state: 'closed', reason: 'fix deployed' }, CLOSED_BREAKER],
        skippedRows: 0,
        limit: 25,
      });

    renderPage();

    const samCard = await screen.findByTestId('breaker-project-sam');
    fireEvent.click(samCard.querySelector('button')!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Close archive circuit breaker');
    const reasonInput = screen.getByLabelText('Reason') as HTMLInputElement;
    expect(reasonInput.value).toBe('Closed from admin UI');
    fireEvent.change(reasonInput, { target: { value: '  fix deployed  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^close breaker$/i }));

    await waitFor(() => {
      expect(mocks.closeAdminProjectDataArchiveCircuitBreaker).toHaveBeenCalledWith(
        'project-sam',
        'fix deployed'
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('breaker-project-sam').querySelector('button')).toBeNull();
    });
    expect(screen.getByTestId('breaker-project-sam')).toHaveTextContent('fix deployed');
    expect(mocks.fetchAdminProjectDataArchiveCircuitBreakers).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open and shows the error when closing fails', async () => {
    mocks.closeAdminProjectDataArchiveCircuitBreaker.mockRejectedValue(
      new Error('D1 write failed')
    );

    renderPage();

    const samCard = await screen.findByTestId('breaker-project-sam');
    fireEvent.click(samCard.querySelector('button')!);
    fireEvent.click(await screen.findByRole('button', { name: /^close breaker$/i }));

    expect(
      await screen.findByText('D1 write failed', { selector: '[role="alert"] *' })
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mocks.fetchAdminProjectDataArchiveCircuitBreakers).toHaveBeenCalledTimes(1);
  });

  it('shows an error when the breaker list fails to load', async () => {
    mocks.fetchAdminProjectDataArchiveCircuitBreakers.mockRejectedValue(new Error('no d1 access'));

    renderPage();

    expect(await screen.findByText('no d1 access')).toBeInTheDocument();
    // Telemetry still renders: one failed query must not blank the page.
    expect(await screen.findByText(/degraded/)).toBeInTheDocument();
  });
});
