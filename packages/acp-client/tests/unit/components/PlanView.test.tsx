import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanView } from '../../../src/components/PlanView';
import type { PlanItem } from '../../../src/hooks/useAcpMessages';

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
    expect(el.style.textDecoration).toBe('line-through');
  });

  it('renders in-progress entries with glow dot', () => {
    const plan = makePlan([
      { content: 'Working', priority: 'high', status: 'in_progress' },
    ]);
    render(<PlanView plan={plan} />);
    const el = screen.getByText('Working');
    const dot = el.previousElementSibling as HTMLElement;
    expect(dot.style.boxShadow).toContain('rgba(34, 197, 94');
  });

  it('renders pending entries without strikethrough or glow', () => {
    const plan = makePlan([
      { content: 'Pending step', priority: 'high', status: 'pending' },
    ]);
    render(<PlanView plan={plan} />);
    const el = screen.getByText('Pending step');
    expect(el.style.textDecoration).not.toBe('line-through');
    const dot = el.previousElementSibling as HTMLElement;
    expect(dot.style.boxShadow).toBe('none');
  });

  it('renders green dot for completed entries', () => {
    const plan = makePlan([
      { content: 'Done', priority: 'high', status: 'completed' },
    ]);
    render(<PlanView plan={plan} />);
    const el = screen.getByText('Done');
    const dot = el.previousElementSibling as HTMLElement;
    expect(dot.style.backgroundColor).toMatch(/#22c55e|rgb\(34,\s*197,\s*94\)/);
  });
});
