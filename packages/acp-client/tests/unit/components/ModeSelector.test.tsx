import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeSelector } from '../../../src/components/ModeSelector';

describe('ModeSelector', () => {
  const modes = ['code', 'architect', 'ask'];

  it('returns null when modes array is empty', () => {
    const { container } = render(
      <ModeSelector modes={[]} currentMode={null} onSelectMode={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders all mode buttons', () => {
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={vi.fn()} />
    );
    expect(screen.getByText('code')).toBeTruthy();
    expect(screen.getByText('architect')).toBeTruthy();
    expect(screen.getByText('ask')).toBeTruthy();
  });

  it('renders a "Mode:" label', () => {
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={vi.fn()} />
    );
    expect(screen.getByText('Mode:')).toBeTruthy();
  });

  it('visually distinguishes the active mode', () => {
    render(
      <ModeSelector modes={modes} currentMode="architect" onSelectMode={vi.fn()} />
    );
    const activeBtn = screen.getByRole('button', { name: 'architect' });
    expect(activeBtn.classList.contains('bg-blue-600')).toBe(true);
    expect(activeBtn.classList.contains('text-white')).toBe(true);
  });

  it('styles inactive modes differently from active', () => {
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={vi.fn()} />
    );
    const inactiveBtn = screen.getByRole('button', { name: 'architect' });
    expect(inactiveBtn.classList.contains('bg-white')).toBe(true);
    expect(inactiveBtn.classList.contains('text-gray-600')).toBe(true);
  });

  it('calls onSelectMode when a mode button is clicked', () => {
    const onSelectMode = vi.fn();
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={onSelectMode} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'architect' }));
    expect(onSelectMode).toHaveBeenCalledWith('architect');
  });

  it('calls onSelectMode with the already-active mode when clicked', () => {
    const onSelectMode = vi.fn();
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={onSelectMode} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'code' }));
    expect(onSelectMode).toHaveBeenCalledWith('code');
  });

  it('renders buttons with accessible names matching mode text', () => {
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={vi.fn()} />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(3);
    expect(buttons.map(b => b.textContent)).toEqual(['code', 'architect', 'ask']);
  });

  it('marks active mode with aria-pressed', () => {
    render(
      <ModeSelector modes={modes} currentMode="code" onSelectMode={vi.fn()} />
    );
    const activeBtn = screen.getByRole('button', { name: 'code' });
    expect(activeBtn.getAttribute('aria-pressed')).toBe('true');

    const inactiveBtn = screen.getByRole('button', { name: 'architect' });
    expect(inactiveBtn.getAttribute('aria-pressed')).toBe('false');
  });
});
