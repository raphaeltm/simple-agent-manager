import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogEntryRow, formatLogEntry, formatLogEntries, type LogEntry } from '../../../../src/components/admin/LogEntryRow';

// Mock clipboard API
const mockWriteText = vi.fn(() => Promise.resolve());
Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

function createEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-03-10T12:00:00.000Z',
    level: 'info',
    event: 'http.request',
    message: 'GET /api/health',
    details: {},
    ...overrides,
  };
}

describe('LogEntryRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders level, timestamp, event, and message', () => {
    render(<LogEntryRow entry={createEntry()} />);

    expect(screen.getByText('info')).toBeInTheDocument();
    expect(screen.getByText('http.request')).toBeInTheDocument();
    expect(screen.getByText('GET /api/health')).toBeInTheDocument();
  });

  it('shows copy button with correct aria label', () => {
    render(<LogEntryRow entry={createEntry()} />);

    const copyBtn = screen.getByTestId('copy-entry-button');
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).toHaveAttribute('aria-label', 'Copy log entry');
  });

  it('copies formatted text to clipboard on click', async () => {
    const entry = createEntry({ message: 'Test message', level: 'error' });
    render(<LogEntryRow entry={entry} />);

    const copyBtn = screen.getByTestId('copy-entry-button');
    fireEvent.click(copyBtn);

    expect(mockWriteText).toHaveBeenCalledTimes(1);
    const copiedText = mockWriteText.mock.calls[0]![0] as string;
    expect(copiedText).toContain('ERROR');
    expect(copiedText).toContain('Test message');
    expect(copiedText).toContain('http.request');
  });

  it('expands details on click when details exist', () => {
    render(
      <LogEntryRow
        entry={createEntry({ details: { requestId: 'abc-123', duration: 42 } })}
      />,
    );

    // Details not visible initially
    expect(screen.queryByText(/"requestId"/)).not.toBeInTheDocument();

    // Click the row (not the copy button) — the row has aria-expanded
    const row = screen.getByRole('button', { expanded: false });
    fireEvent.click(row);

    // Details now visible
    expect(screen.getByText(/"requestId"/)).toBeInTheDocument();
  });

  it('does not expand when clicking copy button (stopPropagation)', () => {
    render(
      <LogEntryRow
        entry={createEntry({ details: { key: 'value' } })}
      />,
    );

    const copyBtn = screen.getByTestId('copy-entry-button');
    fireEvent.click(copyBtn);

    // Details should NOT be expanded
    expect(screen.queryByText(/"key"/)).not.toBeInTheDocument();
  });

  it('highlights search term in message text', () => {
    render(
      <LogEntryRow
        entry={createEntry({ message: 'GET /api/health check' })}
        searchTerm="health"
      />,
    );

    const marks = screen.getAllByText('health');
    // One should be a <mark> element
    const markEl = marks.find((el) => el.tagName === 'MARK');
    expect(markEl).toBeDefined();
  });

  it('handles case-insensitive highlight', () => {
    render(
      <LogEntryRow
        entry={createEntry({ message: 'Error in SessionHost' })}
        searchTerm="sessionhost"
      />,
    );

    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('SessionHost');
  });

  it('renders normally when searchTerm is empty', () => {
    render(
      <LogEntryRow
        entry={createEntry({ message: 'Normal message' })}
        searchTerm=""
      />,
    );

    expect(screen.getByText('Normal message')).toBeInTheDocument();
    expect(document.querySelectorAll('mark').length).toBe(0);
  });

  it('renders normally when searchTerm has no match', () => {
    render(
      <LogEntryRow
        entry={createEntry({ message: 'Normal message' })}
        searchTerm="zzzzz"
      />,
    );

    expect(screen.getByText('Normal message')).toBeInTheDocument();
    expect(document.querySelectorAll('mark').length).toBe(0);
  });

  it('expands details on Enter key press (keyboard accessibility)', () => {
    render(
      <LogEntryRow
        entry={createEntry({ details: { key: 'value' } })}
      />,
    );

    const row = screen.getByRole('button', { expanded: false });
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(screen.getByText(/"key"/)).toBeInTheDocument();
  });

  it('escapes regex special chars in search term', () => {
    render(
      <LogEntryRow
        entry={createEntry({ message: 'path/to/file.ts (test)' })}
        searchTerm="file.ts (test)"
      />,
    );

    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]!.textContent).toBe('file.ts (test)');
  });
});

describe('formatLogEntry', () => {
  it('formats a basic entry', () => {
    const entry = createEntry({ level: 'error', event: 'db.error', message: 'Connection failed' });
    const text = formatLogEntry(entry);

    expect(text).toContain('ERROR');
    expect(text).toContain('db.error');
    expect(text).toContain('Connection failed');
    expect(text).toContain('2026-03-10');
  });

  it('includes details when present', () => {
    const entry = createEntry({ details: { code: 500, msg: 'internal error' } });
    const text = formatLogEntry(entry);

    expect(text).toContain('"code": 500');
    expect(text).toContain('"msg": "internal error"');
  });

  it('omits details when empty', () => {
    const entry = createEntry({ details: {} });
    const text = formatLogEntry(entry);

    // Should be a single line (no JSON block)
    expect(text.split('\n').length).toBe(1);
  });
});

describe('formatLogEntries', () => {
  it('joins multiple entries with double newlines', () => {
    const entries = [
      createEntry({ message: 'First' }),
      createEntry({ message: 'Second' }),
    ];
    const text = formatLogEntries(entries);

    expect(text).toContain('First');
    expect(text).toContain('Second');
    expect(text).toContain('\n\n');
  });
});
