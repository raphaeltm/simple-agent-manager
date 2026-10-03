import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../src/hooks/useToast';
import { renderWithQuery } from '../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  fetchAdminProjectDataArchiveCircuitBreakers: vi.fn(),
  fetchAdminProjectDataStorageTelemetry: vi.fn(),
  closeAdminProjectDataArchiveCircuitBreaker: vi.fn(),
  fetchAdminProjectDataArchiveProblemMigrations: vi.fn(),
  abandonAdminProjectDataArchiveMigration: vi.fn(),
  fetchAdminProjectDataWallRecoveryConfig: vi.fn(),
  runAdminProjectDataWallRecovery: vi.fn(),
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
  fetchAdminProjectDataArchiveProblemMigrations:
    mocks.fetchAdminProjectDataArchiveProblemMigrations,
  abandonAdminProjectDataArchiveMigration: mocks.abandonAdminProjectDataArchiveMigration,
  fetchAdminProjectDataWallRecoveryConfig: mocks.fetchAdminProjectDataWallRecoveryConfig,
  runAdminProjectDataWallRecovery: mocks.runAdminProjectDataWallRecovery,
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

const FROZEN_MIGRATION = {
  migrationId: '67927ce6',
  projectId: 'project-sam',
  sessionId: '1d438cc7',
  state: 'frozen',
  sourceOwnerName: 'g1:s62',
  targetOwnerName: 'g1:a0',
  leaseOwner: null,
  leaseExpiresAt: null,
  attemptCount: 3,
  errorCode: 'compact_archive_deadline_exceeded',
  errorMessage: 'Compact archive R2 deadline exceeded after 3 attempts',
  frozenAt: 1_700_000_050_000,
  poisonedAt: null,
  updatedAt: 1_700_000_100_000,
};

const POISONED_MIGRATION = {
  migrationId: '6d6f3099',
  projectId: 'project-other',
  sessionId: '210e8062',
  state: 'poisoned',
  sourceOwnerName: 'g1:s0',
  targetOwnerName: 'g1:a1',
  leaseOwner: null,
  leaseExpiresAt: null,
  attemptCount: 5,
  errorCode: null,
  errorMessage: null,
  frozenAt: null,
  poisonedAt: 1_700_000_080_000,
  updatedAt: 1_700_000_090_000,
};

const DEFAULT_TELEMETRY = {
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
    mocks.fetchAdminProjectDataStorageTelemetry.mockResolvedValue(DEFAULT_TELEMETRY);
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [],
      warnings: [],
      limit: 25,
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

describe('AdminStorage — Problem Migrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminProjectDataArchiveCircuitBreakers.mockResolvedValue({
      breakers: [],
      skippedRows: 0,
      limit: 25,
    });
    mocks.fetchAdminProjectDataStorageTelemetry.mockResolvedValue({ telemetry: [] });
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [FROZEN_MIGRATION, POISONED_MIGRATION],
      warnings: [],
      limit: 25,
    });
  });

  it('renders problem migrations with state badges and abandon buttons', async () => {
    renderPage();

    const frozenCard = await screen.findByTestId('migration-67927ce6');
    expect(frozenCard).toHaveTextContent('project-sam');
    expect(frozenCard).toHaveTextContent('Frozen');
    expect(frozenCard).toHaveTextContent('1d438cc7');
    expect(frozenCard).toHaveTextContent('compact_archive_deadline_exceeded');
    expect(frozenCard.querySelector('button')).toHaveTextContent(/abandon/i);

    const poisonedCard = screen.getByTestId('migration-6d6f3099');
    expect(poisonedCard).toHaveTextContent('project-other');
    expect(poisonedCard).toHaveTextContent('Poisoned');
    expect(poisonedCard.querySelector('button')).toHaveTextContent(/abandon/i);
  });

  it('abandons a migration with the entered reason and refetches the list', async () => {
    mocks.abandonAdminProjectDataArchiveMigration.mockResolvedValue({
      result: { migrationId: '67927ce6', journalState: 'operator_abandoned' },
    });
    mocks.fetchAdminProjectDataArchiveProblemMigrations
      .mockResolvedValueOnce({
        migrations: [FROZEN_MIGRATION, POISONED_MIGRATION],
        warnings: [],
        limit: 25,
      })
      .mockResolvedValue({
        migrations: [POISONED_MIGRATION],
        warnings: [],
        limit: 25,
      });

    renderPage();

    const frozenCard = await screen.findByTestId('migration-67927ce6');
    fireEvent.click(frozenCard.querySelector('button')!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Abandon migration');
    expect(dialog).toHaveTextContent('67927ce6');
    expect(dialog).toHaveTextContent('1d438cc7');

    const reasonInput = screen.getByLabelText('Reason') as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: '  stuck on g1:s62  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^abandon migration$/i }));

    await waitFor(() => {
      expect(mocks.abandonAdminProjectDataArchiveMigration).toHaveBeenCalledWith(
        'project-sam',
        '67927ce6',
        'stuck on g1:s62'
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('migration-67927ce6')).toBeNull();
    });
    expect(screen.getByTestId('migration-6d6f3099')).toBeInTheDocument();
    expect(mocks.fetchAdminProjectDataArchiveProblemMigrations).toHaveBeenCalledTimes(2);
  });

  it('shows the server refusal message when abandon fails with 400', async () => {
    mocks.abandonAdminProjectDataArchiveMigration.mockRejectedValue(
      new Error('abandon_requires_source_intact: Source already deleted, use copy-back instead')
    );

    renderPage();

    const frozenCard = await screen.findByTestId('migration-67927ce6');
    fireEvent.click(frozenCard.querySelector('button')!);

    const reasonInput = screen.getByLabelText('Reason') as HTMLInputElement;
    fireEvent.change(reasonInput, { target: { value: 'testing' } });
    fireEvent.click(screen.getByRole('button', { name: /^abandon migration$/i }));

    expect(
      await screen.findByText(
        'abandon_requires_source_intact: Source already deleted, use copy-back instead',
        { selector: '[role="alert"] *' }
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mocks.fetchAdminProjectDataArchiveProblemMigrations).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no problem migrations exist', async () => {
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [],
      warnings: [],
      limit: 25,
    });

    renderPage();

    expect(await screen.findByText('No problem migrations.')).toBeInTheDocument();
  });

  it('shows truncation notice when results hit the limit', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...FROZEN_MIGRATION,
      migrationId: `mig-${i}`,
      sessionId: `sess-${i}`,
    }));
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: many,
      warnings: [],
      limit: 25,
    });

    renderPage();

    expect(await screen.findByText(/showing the first 25 problem migrations/i)).toBeInTheDocument();
  });

  it('shows an error when the problem migrations list fails to load', async () => {
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockRejectedValue(
      new Error('D1 unavailable')
    );

    renderPage();

    expect(await screen.findByText('D1 unavailable')).toBeInTheDocument();
  });

  it('renders the "Failed" badge for a failed migration', async () => {
    const failedMigration = {
      ...FROZEN_MIGRATION,
      migrationId: 'failed-1',
      state: 'failed',
      frozenAt: null,
    };
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [failedMigration],
      warnings: [],
      limit: 25,
    });

    renderPage();

    const card = await screen.findByTestId('migration-failed-1');
    expect(card).toHaveTextContent('Failed');
  });

  it('renders "Unknown" badge for an unrecognized state', async () => {
    const unknownMigration = {
      ...FROZEN_MIGRATION,
      migrationId: 'unknown-1',
      state: 'some_future_state',
      frozenAt: null,
    };
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [unknownMigration],
      warnings: [],
      limit: 25,
    });

    renderPage();

    const card = await screen.findByTestId('migration-unknown-1');
    expect(card).toHaveTextContent('Unknown');
  });

  it('shows skipped row warnings when the backend reports them', async () => {
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [FROZEN_MIGRATION],
      warnings: [{ surface: 'problem_migrations', skippedRows: 2 }],
      limit: 25,
    });

    renderPage();

    expect(await screen.findByText(/2 malformed row\(s\) were skipped/)).toBeInTheDocument();
  });

  it('closes the dialog when cancel is clicked', async () => {
    renderPage();

    const frozenCard = await screen.findByTestId('migration-67927ce6');
    fireEvent.click(frozenCard.querySelector('button')!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('AdminStorage — space recovery', () => {
  const MIB = 1024 * 1024;
  const CONFIG = {
    ceilings: { maxRows: 5_000, maxBytes: 32 * MIB, maxSessions: 5 },
    defaults: { maxRows: 500, maxBytes: 4 * MIB, maxSessions: 1 },
  };

  function result(overrides: Record<string, unknown> = {}) {
    return {
      result: {
        projectId: 'project-sam',
        reason: 'wall',
        dryRun: true,
        beforeBytes: 10_737_418_240,
        afterBytes: 10_737_418_240,
        databaseSizeDeltaBytes: 0,
        candidateSessions: 1,
        sessionsTouched: 1,
        sessionsDrained: 0,
        groupedRowsDeleted: 500,
        ftsEntriesDeleted: 0,
        ftsStaleRows: 0,
        contentBytes: 3 * MIB,
        transactions: 0,
        stopReason: 'row_budget',
        error: null,
        failedSessionId: null,
        sessions: [],
        ...overrides,
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminProjectDataArchiveCircuitBreakers.mockResolvedValue({
      breakers: [],
      skippedRows: 0,
      limit: 25,
    });
    mocks.fetchAdminProjectDataStorageTelemetry.mockResolvedValue(DEFAULT_TELEMETRY);
    mocks.fetchAdminProjectDataArchiveProblemMigrations.mockResolvedValue({
      migrations: [],
      warnings: [],
      limit: 25,
    });
    mocks.fetchAdminProjectDataWallRecoveryConfig.mockResolvedValue(CONFIG);
  });

  async function openDialog() {
    renderPage();
    const row = await screen.findByTestId('telemetry-project-sam');
    fireEvent.click(within(row).getByRole('button', { name: /recover space/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Sessions');
    return dialog;
  }

  const field = (dialog: HTMLElement, label: string) =>
    within(dialog).getByLabelText(label) as HTMLInputElement;
  const previewButton = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: /preview/i });
  const recoverButton = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: /recover space/i });

  it('previews, then recovers, with the budgets the API serves', async () => {
    mocks.runAdminProjectDataWallRecovery.mockResolvedValueOnce(result()).mockResolvedValueOnce(
      result({
        dryRun: false,
        afterBytes: 10_737_418_240 - 6 * MIB,
        databaseSizeDeltaBytes: 6 * MIB,
        ftsEntriesDeleted: 500,
        transactions: 3,
      })
    );
    const dialog = await openDialog();

    // Prefilled from the API's defaults, not from the page.
    expect(field(dialog, 'Sessions').value).toBe('1');
    expect(field(dialog, 'Rows').value).toBe('500');
    expect(field(dialog, 'Size (MiB)').value).toBe('4');
    // A destructive emergency call states why: both actions wait for a reason.
    expect(previewButton(dialog)).toBeDisabled();
    expect(recoverButton(dialog)).toBeDisabled();
    fireEvent.change(field(dialog, 'Reason'), { target: { value: '  at the wall  ' } });

    fireEvent.click(previewButton(dialog));
    await waitFor(() =>
      expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenCalledWith('project-sam', {
        reason: 'at the wall',
        dryRun: true,
        maxSessions: 1,
        maxRows: 500,
        maxBytes: 4 * MIB,
        skipSessionIds: [],
      })
    );
    expect(await within(dialog).findByText('Preview: nothing was changed')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Would prune');
    expect(mocks.fetchAdminProjectDataStorageTelemetry).toHaveBeenCalledTimes(1);

    fireEvent.click(recoverButton(dialog));
    await waitFor(() =>
      expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenLastCalledWith(
        'project-sam',
        expect.objectContaining({ dryRun: false })
      )
    );
    expect(await within(dialog).findByText('Recovery finished')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('freed 6.0 MiB');
    // A real run refreshes the page's storage data without closing the result.
    await waitFor(() =>
      expect(mocks.fetchAdminProjectDataStorageTelemetry).toHaveBeenCalledTimes(2)
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Recovery finished');
  });

  it('checks every budget against the API ceilings, including sizes under 1 MiB', async () => {
    mocks.fetchAdminProjectDataWallRecoveryConfig.mockResolvedValue({
      ceilings: { maxRows: 5_000, maxBytes: MIB / 2, maxSessions: 5 },
      defaults: { maxRows: 500, maxBytes: MIB / 4, maxSessions: 1 },
    });
    mocks.runAdminProjectDataWallRecovery.mockResolvedValue(result());
    const dialog = await openDialog();
    fireEvent.change(field(dialog, 'Reason'), { target: { value: 'wall' } });

    expect(field(dialog, 'Size (MiB)').value).toBe('0.25');
    expect(dialog).toHaveTextContent('Max 0.5');

    for (const [label, value, message] of [
      ['Size (MiB)', '0.6', 'At most 0.5 MiB'],
      ['Size (MiB)', '0', 'Enter a size above 0 MiB'],
      ['Rows', '2.5', 'Enter a whole number of 1 or more'],
      ['Rows', '6000', 'At most 5,000'],
      ['Sessions', '0', 'Enter a whole number of 1 or more'],
    ] as const) {
      fireEvent.change(field(dialog, label), { target: { value } });
      expect(dialog).toHaveTextContent(message);
      expect(field(dialog, label)).toHaveAttribute('aria-invalid', 'true');
      expect(previewButton(dialog)).toBeDisabled();
      // Restore a valid value before the next case.
      fireEvent.change(field(dialog, label), {
        target: { value: label === 'Size (MiB)' ? '0.4' : '2' },
      });
      expect(previewButton(dialog)).toBeEnabled();
    }

    fireEvent.click(previewButton(dialog));
    await waitFor(() =>
      expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenCalledWith(
        'project-sam',
        expect.objectContaining({ maxBytes: Math.floor(0.4 * MIB), maxRows: 2, maxSessions: 2 })
      )
    );
  });

  it('reports a failed page and retries only when asked, skipping that session', async () => {
    const failed = result({
      dryRun: false,
      stopReason: 'transaction_failed',
      error: 'Exceeded the maximum database size.',
      failedSessionId: 'session-bad',
      groupedRowsDeleted: 120,
      databaseSizeDeltaBytes: MIB,
    });
    mocks.runAdminProjectDataWallRecovery
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(result({ dryRun: false }));
    const dialog = await openDialog();
    fireEvent.change(field(dialog, 'Reason'), { target: { value: 'wall' } });

    fireEvent.click(recoverButton(dialog));
    expect(await within(dialog).findByText(/A page failed/)).toBeInTheDocument();
    // Pages before the failure were applied and are shown, and nothing retried on its own.
    expect(dialog).toHaveTextContent('120 rows');
    expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('button', { name: /skip this session next run/i }));
    expect(dialog).toHaveTextContent('Skipping 1 session(s):');
    expect(dialog).toHaveTextContent('session-bad');
    // Already on the list: the action is not offered twice.
    expect(
      within(dialog).queryByRole('button', { name: /skip this session next run/i })
    ).toBeNull();

    fireEvent.click(recoverButton(dialog));
    await waitFor(() => expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenCalledTimes(2));
    expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenLastCalledWith(
      'project-sam',
      expect.objectContaining({ skipSessionIds: ['session-bad'] })
    );
    // The same session failing again does not duplicate it on the list.
    await within(dialog).findByText(/A page failed/);
    expect(
      within(dialog).queryByRole('button', { name: /skip this session next run/i })
    ).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: /clear skipped sessions/i }));
    fireEvent.click(recoverButton(dialog));
    await waitFor(() => expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenCalledTimes(3));
    expect(mocks.runAdminProjectDataWallRecovery).toHaveBeenLastCalledWith(
      'project-sam',
      expect.objectContaining({ skipSessionIds: [] })
    );
  });

  it('keeps both actions disabled until the limits load', async () => {
    let resolveConfig: (value: typeof CONFIG) => void = () => undefined;
    mocks.fetchAdminProjectDataWallRecoveryConfig.mockReturnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      })
    );
    renderPage();
    const row = await screen.findByTestId('telemetry-project-sam');
    fireEvent.click(within(row).getByRole('button', { name: /recover space/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(field(dialog, 'Reason'), { target: { value: 'wall' } });

    expect(previewButton(dialog)).toBeDisabled();
    expect(recoverButton(dialog)).toBeDisabled();
    expect(within(dialog).queryByLabelText('Sessions')).toBeNull();

    resolveConfig(CONFIG);
    expect(await within(dialog).findByLabelText('Sessions')).toBeInTheDocument();
    expect(previewButton(dialog)).toBeEnabled();
    expect(mocks.runAdminProjectDataWallRecovery).not.toHaveBeenCalled();
  });
});
