import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette } from '../../src/components/CommandPalette';
import { getPaletteShortcuts } from '../../src/lib/keyboard-shortcuts';

function renderPalette(handlers: Record<string, () => void> = {}) {
  const onClose = vi.fn();
  const result = render(
    <CommandPalette onClose={onClose} handlers={handlers} />
  );
  return { onClose, ...result };
}

describe('CommandPalette', () => {
  it('renders all non-hidden shortcuts when query is empty', () => {
    renderPalette();
    const paletteShortcuts = getPaletteShortcuts();
    // Each visible shortcut should have its description (or consolidated label) rendered
    for (const s of paletteShortcuts) {
      const label = s.id === 'tab-1' ? 'Switch to tab 1\u20139' : s.description;
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('does not render hidden shortcuts (command-palette, tab-2..9)', () => {
    renderPalette();
    expect(screen.queryByText('Open command palette')).toBeNull();
    expect(screen.queryByText('Switch to tab 2')).toBeNull();
    expect(screen.queryByText('Switch to tab 9')).toBeNull();
  });

  it('filters by substring', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'file' } });

    // "Toggle file browser" should still be visible
    expect(screen.getByText('Toggle file browser')).toBeDefined();
    // "Toggle git changes" should not match
    expect(screen.queryByText('Toggle git changes')).toBeNull();
  });

  it('shows "No matching commands" for unmatched query', () => {
    renderPalette();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'xyznonexistent' } });

    expect(screen.getByText('No matching commands')).toBeDefined();
  });

  it('executes selected handler on Enter and closes', () => {
    const handler = vi.fn();
    const { onClose } = renderPalette({ 'toggle-file-browser': handler });
    const input = screen.getByRole('textbox');

    // Filter to just file browser
    fireEvent.change(input, { target: { value: 'file browser' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without executing', () => {
    const handler = vi.fn();
    const { onClose } = renderPalette({ 'toggle-file-browser': handler });
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(handler).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates selection with ArrowDown and ArrowUp', () => {
    renderPalette();
    const input = screen.getByRole('textbox');

    // First item should be selected initially
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');

    // ArrowDown moves to second item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const optionsAfterDown = screen.getAllByRole('option');
    expect(optionsAfterDown[0]?.getAttribute('aria-selected')).toBe('false');
    expect(optionsAfterDown[1]?.getAttribute('aria-selected')).toBe('true');

    // ArrowUp moves back to first item
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const optionsAfterUp = screen.getAllByRole('option');
    expect(optionsAfterUp[0]?.getAttribute('aria-selected')).toBe('true');
    expect(optionsAfterUp[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('clamps selection at boundaries', () => {
    renderPalette();
    const input = screen.getByRole('textbox');

    // ArrowUp from index 0 should stay at 0
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('executes on click and closes', () => {
    const handler = vi.fn();
    const { onClose } = renderPalette({ 'toggle-git-changes': handler });

    const item = screen.getByText('Toggle git changes');
    fireEvent.click(item);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('displays tab-1 as "Switch to tab 1\u20139"', () => {
    renderPalette();
    expect(screen.getByText('Switch to tab 1\u20139')).toBeDefined();
  });

  it('resets selection when query changes', () => {
    renderPalette();
    const input = screen.getByRole('textbox');

    // Move selection down
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Type something — selection should reset to 0
    fireEvent.change(input, { target: { value: 'tab' } });
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('updates selection on mouse hover', () => {
    renderPalette();
    const options = screen.getAllByRole('option');

    // Hover over third item
    fireEvent.mouseEnter(options[2]!);
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
  });
});
