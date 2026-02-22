import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Tooltip } from '../src/components/Tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not show tooltip initially', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows tooltip after delay on mouse enter', () => {
    render(
      <Tooltip content="Help text" delay={400}>
        <button>Hover me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Hover me').closest('span')!.parentElement!;
    fireEvent.mouseEnter(wrapper);

    // Not visible yet
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // Advance past delay
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text');
  });

  it('hides tooltip on mouse leave', () => {
    render(
      <Tooltip content="Help text" delay={0}>
        <button>Hover me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Hover me').closest('span')!.parentElement!;
    fireEvent.mouseEnter(wrapper);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows tooltip immediately on focus', () => {
    render(
      <Tooltip content="Help text" delay={400}>
        <button>Focus me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Focus me').closest('span')!.parentElement!;
    fireEvent.focus(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('hides tooltip on blur', () => {
    render(
      <Tooltip content="Help text" delay={0}>
        <button>Focus me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Focus me').closest('span')!.parentElement!;
    fireEvent.focus(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(wrapper);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('hides tooltip on Escape key', () => {
    render(
      <Tooltip content="Help text" delay={0}>
        <button>Hover me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Hover me').closest('span')!.parentElement!;
    fireEvent.focus(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('sets aria-describedby on trigger when visible', () => {
    render(
      <Tooltip content="Help text" delay={0}>
        <button>Hover me</button>
      </Tooltip>,
    );

    const wrapper = screen.getByText('Hover me').closest('span')!.parentElement!;
    fireEvent.focus(wrapper);

    const tooltip = screen.getByRole('tooltip');
    const trigger = screen.getByText('Hover me').closest('[aria-describedby]');
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
  });
});
