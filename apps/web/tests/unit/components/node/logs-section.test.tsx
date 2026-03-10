import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LogsSection } from '../../../../src/components/node/LogsSection';
import type { NodeLogEntry } from '@simple-agent-manager/shared';

const mockWriteText = vi.fn(() => Promise.resolve());
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

function createEntry(overrides: Partial<NodeLogEntry> = {}): NodeLogEntry {
  return {
    timestamp: '2026-03-10T12:00:00.000Z',
    level: 'info',
    source: 'agent',
    message: 'Session started',
    ...overrides,
  };
}

// Mock useNodeLogs hook
const mockUseNodeLogs = vi.fn();
vi.mock('../../../../src/hooks/useNodeLogs', () => ({
  useNodeLogs: (opts: unknown) => mockUseNodeLogs(opts),
}));

// Mock UI components
vi.mock('@simple-agent-manager/ui', () => ({
  Skeleton: ({ width, height }: { width: string; height: number }) => (
    <div data-testid="skeleton" style={{ width, height }} />
  ),
}));

// Mock section components
vi.mock('../../../../src/components/node/SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => <div data-testid="section-header">{title}</div>,
}));
vi.mock('../../../../src/components/node/Section', () => ({
  Section: ({ children }: { children: React.ReactNode }) => <div data-testid="section">{children}</div>,
}));

function defaultHook(overrides: Partial<ReturnType<typeof mockUseNodeLogs>> = {}) {
  return {
    entries: [],
    loading: false,
    error: null,
    hasMore: false,
    streaming: false,
    paused: false,
    filter: { source: 'all', level: 'info', search: '', container: '' },
    setSource: vi.fn(),
    setLevel: vi.fn(),
    setContainer: vi.fn(),
    setSearch: vi.fn(),
    loadMore: vi.fn(),
    togglePause: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('LogsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Start the node" message when not running', () => {
    mockUseNodeLogs.mockReturnValue(defaultHook());
    render(<LogsSection nodeId="node-1" nodeStatus="stopped" />);
    expect(screen.getByText(/start the node/i)).toBeInTheDocument();
  });

  it('shows entries when node is running', () => {
    mockUseNodeLogs.mockReturnValue(
      defaultHook({ entries: [createEntry({ message: 'hello log' })] }),
    );
    render(<LogsSection nodeId="node-1" nodeStatus="running" />);
    expect(screen.getByText('hello log')).toBeInTheDocument();
  });

  it('shows Copy All button when entries exist', () => {
    mockUseNodeLogs.mockReturnValue(
      defaultHook({ entries: [createEntry()] }),
    );
    render(<LogsSection nodeId="node-1" nodeStatus="running" />);
    expect(screen.getByTestId('copy-all-button')).toBeInTheDocument();
  });

  it('does not show Copy All button when no entries', () => {
    mockUseNodeLogs.mockReturnValue(defaultHook());
    render(<LogsSection nodeId="node-1" nodeStatus="running" />);
    expect(screen.queryByTestId('copy-all-button')).not.toBeInTheDocument();
  });

  it('copies all entries to clipboard when Copy All is clicked', async () => {
    const entries = [
      createEntry({ message: 'First entry' }),
      createEntry({ message: 'Second entry', level: 'error' }),
    ];
    mockUseNodeLogs.mockReturnValue(defaultHook({ entries }));

    render(<LogsSection nodeId="node-1" nodeStatus="running" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-all-button'));
    });

    expect(mockWriteText).toHaveBeenCalledTimes(1);
    const copiedText = mockWriteText.mock.calls[0]![0] as string;
    expect(copiedText).toContain('First entry');
    expect(copiedText).toContain('Second entry');
  });

  it('shows empty state when no entries with filters', () => {
    mockUseNodeLogs.mockReturnValue(defaultHook());
    render(<LogsSection nodeId="node-1" nodeStatus="running" />);
    expect(screen.getByText(/no log entries found/i)).toBeInTheDocument();
  });

  it('shows loading skeletons when loading with no entries', () => {
    mockUseNodeLogs.mockReturnValue(defaultHook({ loading: true }));
    render(<LogsSection nodeId="node-1" nodeStatus="running" />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });
});
