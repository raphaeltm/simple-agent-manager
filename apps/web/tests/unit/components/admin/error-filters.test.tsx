import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorList } from '../../../../src/components/admin/ErrorList';

vi.mock('../../../../src/lib/api', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    fetchAdminErrors: vi.fn().mockResolvedValue({
      errors: [
        {
          id: 'e1',
          source: 'api',
          level: 'error',
          message: 'Test error 1',
          stack: null,
          context: null,
          userId: null,
          nodeId: null,
          workspaceId: null,
          ipAddress: null,
          userAgent: null,
          timestamp: '2026-08-07T12:00:00.000Z',
        },
        {
          id: 'e2',
          source: 'vm-agent',
          level: 'warn',
          message: 'Test error 2',
          stack: null,
          context: null,
          userId: null,
          nodeId: null,
          workspaceId: null,
          ipAddress: null,
          userAgent: null,
          timestamp: '2026-08-07T11:00:00.000Z',
        },
      ],
      cursor: null,
      hasMore: false,
      total: 2,
    }),
    fetchAdminDebugDiagnoses: vi.fn().mockResolvedValue({
      diagnoses: [],
      runs: [],
    }),
    runAdminDebugDiagnosis: vi.fn(),
    retryAdminDebugDiagnosisRun: vi.fn(),
  };
});

describe('ErrorList URL param round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads filter values from URL params on mount', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/errors?source=api&level=error&range=1h&nodeId=n1']}>
        <ErrorList />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Test error 1')).toBeInTheDocument();
    });

    const sourceSelect = screen.getByLabelText('Filter by source') as HTMLSelectElement;
    expect(sourceSelect.value).toBe('api');

    const levelSelect = screen.getByLabelText('Filter by level') as HTMLSelectElement;
    expect(levelSelect.value).toBe('error');

    const timeRangeSelect = screen.getByLabelText('Filter by time range') as HTMLSelectElement;
    expect(timeRangeSelect.value).toBe('1h');
  });

  it('renders errors without unmounting on refetch', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/errors']}>
        <ErrorList />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Test error 1')).toBeInTheDocument();
    });

    expect(screen.getByText('Test error 1')).toBeInTheDocument();
    expect(screen.getByText('Test error 2')).toBeInTheDocument();
  });

  it('shows auto-refresh toggle', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/errors']}>
        <ErrorList />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Test error 1')).toBeInTheDocument();
    });

    expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
  });

  it('shows ID filters toggle', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/errors']}>
        <ErrorList />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Test error 1')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Toggle ID filters')).toBeInTheDocument();
  });
});
