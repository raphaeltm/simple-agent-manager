import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { NodeLogEntry } from '@simple-agent-manager/shared';
import { LogEntry, formatNodeLogEntry, formatNodeLogEntries } from '../../../../src/components/node/LogEntry';

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

describe('LogEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders timestamp, level, source, and message', () => {
    render(<LogEntry entry={createEntry()} />);
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('Session started')).toBeInTheDocument();
    expect(screen.getByText('INF')).toBeInTheDocument();
  });

  it('shows copy button with correct aria label', () => {
    render(<LogEntry entry={createEntry()} />);
    const copyBtn = screen.getByTestId('copy-entry-button');
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).toHaveAttribute('aria-label', 'Copy log entry');
  });

  it('copies formatted text to clipboard on click', async () => {
    const entry = createEntry({ level: 'error', source: 'docker', message: 'Container crashed' });
    render(<LogEntry entry={entry} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-entry-button'));
    });

    expect(mockWriteText).toHaveBeenCalledTimes(1);
    const copiedText = mockWriteText.mock.calls[0]![0] as string;
    expect(copiedText).toContain('ERROR');
    expect(copiedText).toContain('[docker]');
    expect(copiedText).toContain('Container crashed');
  });

  it('highlights search term in message', () => {
    render(<LogEntry entry={createEntry({ message: 'Session started ok' })} searchTerm="started" />);
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('started');
  });

  it('expands metadata on click when metadata exists', () => {
    render(
      <LogEntry entry={createEntry({ metadata: { requestId: 'abc-123' } })} />,
    );

    expect(screen.queryByText(/"requestId"/)).not.toBeInTheDocument();

    // Click the entry row (the outermost div)
    const row = document.querySelector('.group')!;
    fireEvent.click(row);

    expect(screen.getByText(/"requestId"/)).toBeInTheDocument();
  });

  it('does not expand when clicking copy button', async () => {
    render(
      <LogEntry entry={createEntry({ metadata: { key: 'value' } })} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-entry-button'));
    });

    expect(screen.queryByText(/"key"/)).not.toBeInTheDocument();
  });
});

describe('formatNodeLogEntry', () => {
  it('formats entry with source in brackets', () => {
    const text = formatNodeLogEntry(createEntry({ source: 'docker', message: 'hello' }));
    expect(text).toContain('[docker]');
    expect(text).toContain('hello');
    expect(text).toContain('INFO');
  });

  it('includes metadata when present', () => {
    const text = formatNodeLogEntry(createEntry({ metadata: { pid: 1234 } }));
    expect(text).toContain('"pid": 1234');
  });

  it('omits metadata when empty', () => {
    const text = formatNodeLogEntry(createEntry({ metadata: {} }));
    expect(text.split('\n').length).toBe(1);
  });
});

describe('formatNodeLogEntries', () => {
  it('joins entries with newlines', () => {
    const entries = [
      createEntry({ message: 'First' }),
      createEntry({ message: 'Second' }),
    ];
    const text = formatNodeLogEntries(entries);
    expect(text).toContain('First');
    expect(text).toContain('Second');
  });
});
