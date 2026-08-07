import type { PlatformError } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { ErrorList } from '../../../../src/components/admin/ErrorList';

const mockRunAdminDebugDiagnosis = vi.fn();
const mockFetchAdminDebugDiagnoses = vi.fn();
vi.mock('../../../../src/lib/api', () => ({
  runAdminDebugDiagnosis: (...args: unknown[]) => mockRunAdminDebugDiagnosis(...args),
  fetchAdminDebugDiagnoses: (...args: unknown[]) => mockFetchAdminDebugDiagnoses(...args),
  fetchAdminDebugProjects: vi.fn().mockResolvedValue({ projects: [] }),
  saveAdminDebugDiagnosisAsIdea: vi.fn(),
}));

// Mock the useAdminErrors hook
const mockUseAdminErrors = vi.fn();
vi.mock('../../../../src/hooks/useAdminErrors', () => ({
  useAdminErrors: () => mockUseAdminErrors(),
}));

// Mock the UI library components
vi.mock('@simple-agent-manager/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  Spinner: ({ size }: { size: string }) => <div data-testid={`spinner-${size}`}>Loading...</div>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Body: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <p style={style}>{children}</p>
  ),
}));

function createMockEntry(overrides: Partial<PlatformError> = {}): PlatformError {
  return {
    id: `err-${Math.random().toString(36).slice(2)}`,
    source: 'client',
    level: 'error',
    message: 'Test error',
    stack: null,
    context: null,
    userId: null,
    nodeId: null,
    workspaceId: null,
    ipAddress: null,
    userAgent: null,
    timestamp: '2026-02-14T12:00:00.000Z',
    ...overrides,
  };
}

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    errors: [] as PlatformError[],
    loading: false,
    error: null,
    hasMore: false,
    total: 0,
    filter: {
      source: 'all' as const,
      level: 'all' as const,
      search: '',
      timeRange: '24h' as const,
      nodeId: '',
      workspaceId: '',
      taskId: '',
      sessionId: '',
      userId: '',
    },
    setSource: vi.fn(),
    setLevel: vi.fn(),
    setSearch: vi.fn(),
    setTimeRange: vi.fn(),
    setNodeId: vi.fn(),
    setWorkspaceId: vi.fn(),
    setTaskId: vi.fn(),
    setSessionId: vi.fn(),
    setUserId: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    autoRefresh: false,
    setAutoRefresh: vi.fn(),
    ...overrides,
  };
}

function renderErrorList() {
  return render(<MemoryRouter><ErrorList /></MemoryRouter>);
}

describe('ErrorList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAdminDebugDiagnoses.mockResolvedValue({ diagnoses: [] });
  });

  it('should show loading spinner when loading with no errors', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ loading: true }));
    renderErrorList();
    expect(screen.getByTestId('spinner-lg')).toBeInTheDocument();
  });

  it('should show empty state when no errors match filters', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    renderErrorList();
    expect(screen.getByText(/No errors match/)).toBeInTheDocument();
  });

  it('should render error entries', () => {
    const errors = [
      createMockEntry({ message: 'Error A' }),
      createMockEntry({ message: 'Error B' }),
    ];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 2 }));
    renderErrorList();

    expect(screen.getByText('Error A')).toBeInTheDocument();
    expect(screen.getByText('Error B')).toBeInTheDocument();
  });

  it('should show summary count', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 5 }));
    renderErrorList();

    expect(screen.getByText(/Showing 1 of 5 errors/)).toBeInTheDocument();
  });

  it('should show Load More button when hasMore is true', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 10, hasMore: true }));
    renderErrorList();

    expect(screen.getByText('Load More')).toBeInTheDocument();
  });

  it('should not show Load More button when hasMore is false', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 1, hasMore: false }));
    renderErrorList();

    expect(screen.queryByText('Load More')).not.toBeInTheDocument();
  });

  it('should show error banner with retry button', () => {
    const refresh = vi.fn();
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ error: 'Network error', refresh }));
    renderErrorList();

    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('should show filter controls', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    renderErrorList();

    // Filter dropdowns should be present (rendered by ObservabilityFilters)
    expect(screen.getByLabelText('Filter by source')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by level')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by time range')).toBeInTheDocument();
    expect(screen.getByLabelText('Search error messages')).toBeInTheDocument();
  });

  it('runs a diagnosis for an error row and renders bounded usage metadata', async () => {
    const entry = createMockEntry({ id: 'err-target', message: 'Target failure' });
    mockRunAdminDebugDiagnosis.mockResolvedValue({
      diagnosis: {
        id: 'diag-1', errorId: 'err-target', startTime: '2026-02-14T11:45:00Z',
        endTime: '2026-02-14T12:15:00Z', diagnosis: '## Summary\nHeartbeat stopped.',
        model: '@cf/zai-org/glm-5.2', ideaId: null, createdBy: 'admin',
        createdAt: '2026-02-14T12:16:00Z',
        usage: { turns: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120, dailyTokensUsed: 120, dailyTokenLimit: 120000 },
      },
    });
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors: [entry], total: 1 }));
    renderErrorList();
    fireEvent.click(screen.getByRole('button', { name: 'Diagnose' }));
    await waitFor(() => expect(mockRunAdminDebugDiagnosis).toHaveBeenCalledWith({ errorId: 'err-target' }));
    expect(await screen.findByText(/Heartbeat stopped/)).toBeInTheDocument();
    expect(screen.getByText('Run tokens: 120')).toBeInTheDocument();
  });


  it('restores a persisted diagnosis on the error surface', async () => {
    mockFetchAdminDebugDiagnoses.mockResolvedValue({
      diagnoses: [{
        id: 'diag-saved', errorId: 'err-old', startTime: '2026-02-14T11:45:00Z',
        endTime: '2026-02-14T12:15:00Z', diagnosis: 'Persisted diagnosis evidence',
        model: '@cf/zai-org/glm-5.2', ideaId: null, createdBy: 'admin',
        createdAt: '2026-02-14T12:16:00Z',
        usage: { turns: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120, dailyTokensUsed: 120, dailyTokenLimit: 120000 },
      }],
    });
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    renderErrorList();
    // Click the saved diagnoses button to open the picker
    fireEvent.click(await screen.findByRole('button', { name: 'Saved diagnoses (1)' }));
    // Select the diagnosis from the picker dropdown
    const item = screen.getByText(/Persisted diagnosis evidence/);
    fireEvent.click(item);
    // The DebugDiagnosisPanel should now show the diagnosis
    expect(screen.getByText(/Persisted diagnosis evidence/)).toBeInTheDocument();
  });
  it('should show refresh button', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    renderErrorList();

    // "Refresh" button in the summary bar
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });
});
