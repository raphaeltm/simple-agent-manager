import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StickyPlanButton } from './StickyPlanButton';
import type { PlanItem } from '../hooks/useAcpMessages';

function makePlan(overrides: Partial<PlanItem> = {}, entries?: PlanItem['entries']): PlanItem {
  return {
    kind: 'plan',
    id: 'plan-1',
    timestamp: Date.now(),
    entries: entries ?? [
      { content: 'Step 1', priority: 'high', status: 'completed' },
      { content: 'Step 2', priority: 'medium', status: 'in_progress' },
      { content: 'Step 3', priority: 'low', status: 'pending' },
    ],
    ...overrides,
  };
}

describe('StickyPlanButton', () => {
  it('renders nothing when plan is undefined', () => {
    const onClick = vi.fn();
    const { container } = render(<StickyPlanButton plan={undefined} onClick={onClick} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders when a plan exists', () => {
    const onClick = vi.fn();
    render(<StickyPlanButton plan={makePlan()} onClick={onClick} />);
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('shows correct completion count', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'completed' },
      { content: 'B', priority: 'high', status: 'completed' },
      { content: 'C', priority: 'high', status: 'pending' },
      { content: 'D', priority: 'high', status: 'pending' },
    ]);
    render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    expect(screen.getByText('2/4')).toBeTruthy();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<StickyPlanButton plan={makePlan()} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows pulse dot when work is in progress', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'in_progress' },
    ]);
    const { container } = render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    const pulseDot = container.querySelector('.animate-pulse');
    expect(pulseDot).toBeTruthy();
  });

  it('does not show pulse dot when all complete', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'completed' },
      { content: 'B', priority: 'high', status: 'completed' },
    ]);
    const { container } = render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    const pulseDot = container.querySelector('.animate-pulse');
    expect(pulseDot).toBeNull();
  });

  it('uses green styling when all complete', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'completed' },
    ]);
    render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-green-300');
  });

  it('uses blue styling when in progress', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'in_progress' },
    ]);
    render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-blue-300');
  });

  it('uses gray styling when all pending', () => {
    const plan = makePlan({}, [
      { content: 'A', priority: 'high', status: 'pending' },
    ]);
    render(<StickyPlanButton plan={plan} onClick={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-gray-300');
  });

  it('has accessible label with completion info', () => {
    render(<StickyPlanButton plan={makePlan()} onClick={vi.fn()} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('View plan, 1 of 3 steps complete');
  });
});
