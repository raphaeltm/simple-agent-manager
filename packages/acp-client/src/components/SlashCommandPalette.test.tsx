import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SlashCommandPalette } from './SlashCommandPalette';
import type { SlashCommandPaletteHandle } from './SlashCommandPalette';
import type { SlashCommand } from '../types';

const MOCK_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compress conversation context', source: 'agent' },
  { name: 'clear', description: 'Clear chat history', source: 'client' },
  { name: 'copy', description: 'Copy last response to clipboard', source: 'client' },
  { name: 'model', description: 'Switch between models', source: 'agent' },
];

function makeEvent(key: string) {
  return { key, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

describe('SlashCommandPalette', () => {
  it('renders nothing when not visible', () => {
    const { container } = render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={false}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders all commands when filter is empty', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getByText('/clear')).toBeTruthy();
    expect(screen.getByText('/copy')).toBeTruthy();
    expect(screen.getByText('/model')).toBeTruthy();
  });

  it('filters commands by name prefix', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter="co"
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getByText('/copy')).toBeTruthy();
    expect(screen.queryByText('/clear')).toBeNull();
    expect(screen.queryByText('/model')).toBeNull();
  });

  it('renders nothing when no commands match the filter', () => {
    const { container } = render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter="zzz"
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('calls onSelect when a command is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={onSelect}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    fireEvent.click(screen.getByText('/clear'));
    expect(onSelect).toHaveBeenCalledWith(MOCK_COMMANDS[1]);
  });

  it('shows source badges for agent and client commands', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    const badges = screen.getAllByText('Agent');
    expect(badges).toHaveLength(2);

    const samBadges = screen.getAllByText('SAM');
    expect(samBadges).toHaveLength(2);
  });

  it('shows command descriptions', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    expect(screen.getByText('Compress conversation context')).toBeTruthy();
    expect(screen.getByText('Clear chat history')).toBeTruthy();
  });

  it('has min 44px row height for touch targets', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    const options = screen.getAllByRole('option');
    for (const option of options) {
      expect(option.style.minHeight).toBe('44px');
    }
  });

  it('renders in document flow (not absolute positioned) to avoid overlapping input', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    const listbox = screen.getByRole('listbox');
    // Must NOT use absolute positioning which causes overlap on mobile
    expect(listbox.className).not.toContain('absolute');
    expect(listbox.className).not.toContain('bottom-full');
  });

  it('does not truncate command descriptions (text wraps)', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    const description = screen.getByText('Compress conversation context');
    // Description should not have the "truncate" class
    expect(description.className).not.toContain('truncate');
  });

  it('case-insensitive filtering', () => {
    render(
      <SlashCommandPalette
        commands={MOCK_COMMANDS}
        filter="CO"
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    expect(screen.getByText('/compact')).toBeTruthy();
    expect(screen.getByText('/copy')).toBeTruthy();
  });
});

describe('SlashCommandPalette keyboard navigation', () => {
  it('selects first command on Enter via handleKeyDown ref', () => {
    const onSelect = vi.fn();
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={onSelect}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    act(() => {
      handle?.handleKeyDown(makeEvent('Enter'));
    });

    expect(onSelect).toHaveBeenCalledWith(MOCK_COMMANDS[0]);
  });

  it('navigates down with ArrowDown and wraps around', () => {
    const onSelect = vi.fn();
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={onSelect}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    // Move to index 1
    act(() => { handle?.handleKeyDown(makeEvent('ArrowDown')); });
    // Move to index 2
    act(() => { handle?.handleKeyDown(makeEvent('ArrowDown')); });
    // Select it
    act(() => { handle?.handleKeyDown(makeEvent('Enter')); });

    expect(onSelect).toHaveBeenCalledWith(MOCK_COMMANDS[2]);
  });

  it('navigates up with ArrowUp wraps to last item', () => {
    const onSelect = vi.fn();
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={onSelect}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    // At index 0, ArrowUp wraps to last item (index 3)
    act(() => { handle?.handleKeyDown(makeEvent('ArrowUp')); });
    act(() => { handle?.handleKeyDown(makeEvent('Enter')); });

    expect(onSelect).toHaveBeenCalledWith(MOCK_COMMANDS[3]);
  });

  it('dismisses on Escape', () => {
    const onDismiss = vi.fn();
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={onDismiss}
        visible={true}
      />
    );

    act(() => { handle?.handleKeyDown(makeEvent('Escape')); });

    expect(onDismiss).toHaveBeenCalled();
  });

  it('selects on Tab (shell-like behavior)', () => {
    const onSelect = vi.fn();
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={onSelect}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    act(() => { handle?.handleKeyDown(makeEvent('Tab')); });

    expect(onSelect).toHaveBeenCalledWith(MOCK_COMMANDS[0]);
  });

  it('returns false for non-navigation keys', () => {
    let handle: SlashCommandPaletteHandle | null = null;

    render(
      <SlashCommandPalette
        ref={(h) => { handle = h; }}
        commands={MOCK_COMMANDS}
        filter=""
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
        visible={true}
      />
    );

    let consumed: boolean | undefined;
    act(() => {
      consumed = handle?.handleKeyDown(makeEvent('a'));
    });

    expect(consumed).toBe(false);
  });
});
