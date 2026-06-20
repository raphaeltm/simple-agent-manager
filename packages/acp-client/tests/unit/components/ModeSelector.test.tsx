import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeSelector } from '../../../src/components/ModeSelector';

const defaultModes = ['code', 'architect', 'ask'];

function renderSelector(overrides: { modes?: string[]; currentMode?: string | null } = {}) {
  const onSelectMode = vi.fn();
  const result = render(
    <ModeSelector
      modes={overrides.modes ?? defaultModes}
      currentMode={overrides.currentMode ?? 'code'}
      onSelectMode={onSelectMode}
    />
  );
  return { ...result, onSelectMode };
}

describe('ModeSelector', () => {
  it('returns null when modes array is empty', () => {
    const { container } = renderSelector({ modes: [] });
    expect(container.innerHTML).toBe('');
  });

  it('renders all mode buttons', () => {
    renderSelector();
    expect(screen.getByText('code')).toBeTruthy();
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getByText('ask')).toBeTruthy();
  });

  it('renders a "Mode:" label', () => {
    renderSelector();
    expect(screen.getByText('Mode:')).toBeTruthy();
  });

  it('visually distinguishes the active mode', () => {
    renderSelector({ currentMode: 'architect' });
    const activeBtn = screen.getByRole('button', { name: 'architect' });
    expect(activeBtn.classList.contains('bg-blue-600')).toBe(true);
    expect(activeBtn.classList.contains('text-white')).toBe(true);
  });

  it('styles inactive modes differently from active', () => {
    renderSelector();
    const inactiveBtn = screen.getByRole('button', { name: 'architect' });
    expect(inactiveBtn.classList.contains('bg-white')).toBe(true);
    expect(inactiveBtn.classList.contains('text-gray-600')).toBe(true);
  });

  it('calls onSelectMode when a mode button is clicked', () => {
    const { onSelectMode } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'architect' }));
    expect(onSelectMode).toHaveBeenCalledWith('architect');
  });

  it('calls onSelectMode with the already-active mode when clicked', () => {
    const { onSelectMode } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: 'code' }));
    expect(onSelectMode).toHaveBeenCalledWith('code');
  });

  it('renders buttons with accessible names matching mode text', () => {
    renderSelector();
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(3);
    expect(buttons.map((b) => b.textContent)).toEqual(['code', 'architect', 'ask']);
  });

  it('marks active mode with aria-pressed', () => {
    renderSelector();
    const activeBtn = screen.getByRole('button', { name: 'code' });
    expect(activeBtn.getAttribute('aria-pressed')).toBe('true');

    const inactiveBtn = screen.getByRole('button', { name: 'architect' });
    expect(inactiveBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
