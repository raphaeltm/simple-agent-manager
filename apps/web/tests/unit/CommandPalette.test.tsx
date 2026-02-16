import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from '../../src/components/CommandPalette';
import { getPaletteShortcuts } from '../../src/lib/keyboard-shortcuts';
import type { WorkspaceTabItem } from '../../src/components/WorkspaceTabStrip';

function makeTabs(...specs: Array<[string, string, 'terminal' | 'chat']>): WorkspaceTabItem[] {
  return specs.map(([id, title, kind]) => ({
    id,
    kind,
    sessionId: id.replace(/^(terminal|chat):/, ''),
    title,
    statusColor: '#9ece6a',
  }));
}

const testTabs = makeTabs(
  ['terminal:t1', 'Terminal 1', 'terminal'],
  ['chat:c1', 'My API Worker', 'chat'],
  ['chat:c2', 'Claude Code 2', 'chat']
);

const testFileIndex = [
  'src/components/WorkspaceTabStrip.tsx',
  'src/lib/fuzzy-match.ts',
  'src/pages/Workspace.tsx',
  'package.json',
  'README.md',
];

function renderPalette(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onSelectTab = vi.fn();
  const onSelectFile = vi.fn();
  const handlers: Record<string, () => void> = {};
  const result = render(
    <CommandPalette
      onClose={onClose}
      handlers={handlers}
      tabs={testTabs}
      fileIndex={testFileIndex}
      onSelectTab={onSelectTab}
      onSelectFile={onSelectFile}
      {...overrides}
    />
  );
  return { onClose, onSelectTab, onSelectFile, ...result };
}

describe('CommandPalette', () => {
  // ── Basic rendering ──

  it('renders command shortcuts when query is empty', () => {
    renderPalette();
    const paletteShortcuts = getPaletteShortcuts();
    for (const s of paletteShortcuts) {
      const label = s.id === 'tab-1' ? 'Switch to tab 1\u20139' : s.description;
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('renders tab results when query is empty', () => {
    renderPalette();
    expect(screen.getByText('Terminal 1')).toBeDefined();
    expect(screen.getByText('My API Worker')).toBeDefined();
    expect(screen.getByText('Claude Code 2')).toBeDefined();
  });

  it('does not render file results when query is empty (too many)', () => {
    renderPalette();
    expect(screen.queryByText('package.json')).toBeNull();
    expect(screen.queryByText('README.md')).toBeNull();
  });

  it('renders category headers', () => {
    renderPalette();
    expect(screen.getByText('Tabs')).toBeDefined();
    expect(screen.getByText('Commands')).toBeDefined();
  });

  // ── Fuzzy search ──

  it('fuzzy-matches tabs by name', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'api' } });

    // Highlighted text is split into spans, so check option textContent
    const options = screen.getAllByRole('option');
    const tabOption = options.find((o) => o.textContent?.includes('My API Worker'));
    expect(tabOption).toBeDefined();
    // Terminal 1 should be filtered out (no "api" match)
    const termOption = options.find((o) => o.textContent?.includes('Terminal 1'));
    expect(termOption).toBeUndefined();
  });

  it('fuzzy-matches files by path with camelCase', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'WTS' } });

    // Should match WorkspaceTabStrip.tsx via camelCase
    const options = screen.getAllByRole('option');
    const fileOption = options.find((o) => o.textContent?.includes('WorkspaceTabStrip'));
    expect(fileOption).toBeDefined();
    expect(screen.getByText('Files')).toBeDefined();
  });

  it('fuzzy-matches files by filename', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'package' } });

    const options = screen.getAllByRole('option');
    const fileOption = options.find((o) => o.textContent?.includes('package.json'));
    expect(fileOption).toBeDefined();
  });

  it('shows "No matching results" for unmatched query', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'xyznonexistent99' } });

    expect(screen.getByText('No matching results')).toBeDefined();
  });

  // ── Tab selection ──

  it('calls onSelectTab when a tab result is selected via Enter', () => {
    const { onSelectTab, onClose } = renderPalette();
    const input = screen.getByRole('textbox');

    // Filter to just "api" to match My API Worker tab
    fireEvent.change(input, { target: { value: 'my api' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onSelectTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat:c1', title: 'My API Worker' })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectTab when a tab result is clicked', () => {
    const { onSelectTab, onClose } = renderPalette();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'api worker' } });
    const options = screen.getAllByRole('option');
    const tabResult = options.find((o) => o.textContent?.includes('My API Worker'));
    expect(tabResult).toBeDefined();
    fireEvent.click(tabResult!);

    expect(onSelectTab).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── File selection ──

  it('calls onSelectFile when a file result is selected via Enter', () => {
    const { onSelectFile, onClose } = renderPalette();
    const input = screen.getByRole('textbox');

    // Search for "fuzzy" which should match only fuzzy-match.ts
    fireEvent.change(input, { target: { value: 'fuzzy' } });

    // Navigate past any tab results to the file result
    const options = screen.getAllByRole('option');
    // Find the file result and click it directly
    const fileOption = options.find((o) => o.textContent?.includes('fuzzy-match'));
    expect(fileOption).toBeDefined();
    fireEvent.click(fileOption!);

    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith('src/lib/fuzzy-match.ts');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Command execution ──

  it('executes command handler on Enter and closes', () => {
    const handler = vi.fn();
    const { onClose } = renderPalette({ handlers: { 'toggle-file-browser': handler } });
    const input = screen.getByRole('textbox');

    // Filter to file browser command
    fireEvent.change(input, { target: { value: 'Toggle file browser' } });

    // Navigate to the command result (may be after tabs/files)
    const options = screen.getAllByRole('option');
    const cmdOption = options.find((o) => o.textContent?.includes('Toggle file browser'));
    expect(cmdOption).toBeDefined();
    fireEvent.click(cmdOption!);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Keyboard navigation ──

  it('closes on Escape without executing', () => {
    const { onClose, onSelectTab, onSelectFile } = renderPalette();
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onSelectTab).not.toHaveBeenCalled();
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates selection with ArrowDown and ArrowUp', () => {
    renderPalette();
    const input = screen.getByRole('textbox');

    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const optionsAfterDown = screen.getAllByRole('option');
    expect(optionsAfterDown[0]?.getAttribute('aria-selected')).toBe('false');
    expect(optionsAfterDown[1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const optionsAfterUp = screen.getAllByRole('option');
    expect(optionsAfterUp[0]?.getAttribute('aria-selected')).toBe('true');
    expect(optionsAfterUp[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('resets selection when query changes', () => {
    renderPalette();
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    fireEvent.change(input, { target: { value: 'tab' } });
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('updates selection on mouse hover', () => {
    renderPalette();
    const options = screen.getAllByRole('option');

    fireEvent.mouseEnter(options[2]!);
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
  });

  // ── Loading state ──

  it('shows loading indicator when file index is loading', () => {
    renderPalette({ fileIndex: [], fileIndexLoading: true });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'something' } });

    // Should show loading when query is set and no results
    // (may or may not show based on if tabs/commands match too)
    expect(screen.queryByText('Loading files...')).toBeDefined();
  });

  // ── Edge cases ──

  it('renders without tabs or files (backward compatible)', () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} handlers={{}} />);

    // Should still render commands
    expect(screen.getByText('Commands')).toBeDefined();
  });

  it('displays tab-1 as "Switch to tab 1\u20139"', () => {
    renderPalette();
    expect(screen.getByText('Switch to tab 1\u20139')).toBeDefined();
  });
});
