import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanView } from './PlanView';
import type { PlanItem } from '../hooks/useAcpMessages';

function makePlan(entries?: PlanItem['entries']): PlanItem {
  return {
    kind: 'plan',
    id: 'plan-1',
    timestamp: Date.now(),
    entries: entries ?? [
      { content: 'Step 1', priority: 'high', status: 'completed' },
      { content: 'Step 2', priority: 'medium', status: 'in_progress' },
      { content: 'Step 3', priority: 'low', status: 'pending' },
    ],
  };
}

describe('PlanView', () => {
  it('renders all plan entries', () => {
    render(<PlanView plan={makePlan()} />);
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(screen.getByText('Step 2')).toBeTruthy();
    expect(screen.getByText('Step 3')).toBeTruthy();
  });

  it('renders "Plan" heading', () => {
    render(<PlanView plan={makePlan()} />);
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('renders completed entries with strikethrough', () => {
    const plan = makePlan([
      { content: 'Done step', priority: 'high', status: 'completed' },
    ]);
    render(<PlanView plan={plan} />);
    const el = screen.getByText('Done step');
    expect(el.className).toContain('line-through');
  });

  it('renders in-progress entries with pulsing dot', () => {
    const plan = makePlan([
      { content: 'Working', priority: 'high', status: 'in_progress' },
    ]);
    const { container } = render(<PlanView plan={plan} />);
    const pulseDot = container.querySelector('.animate-pulse');
    expect(pulseDot).toBeTruthy();
  });

  it('renders pending entries without strikethrough or pulse', () => {
    const plan = makePlan([
      { content: 'Pending step', priority: 'high', status: 'pending' },
    ]);
    const { container } = render(<PlanView plan={plan} />);
    const el = screen.getByText('Pending step');
    expect(el.className).not.toContain('line-through');
    expect(container.querySelector('.animate-pulse')).toBeFalsy();
  });

  it('renders green dot for completed entries', () => {
    const plan = makePlan([
      { content: 'Done', priority: 'high', status: 'completed' },
    ]);
    const { container } = render(<PlanView plan={plan} />);
    const dot = container.querySelector('.bg-green-400');
    expect(dot).toBeTruthy();
  });
});
