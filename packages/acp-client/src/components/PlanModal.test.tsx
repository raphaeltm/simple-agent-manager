import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanModal } from './PlanModal';
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

describe('PlanModal', () => {
  it('renders nothing when not open', () => {
    const { container } = render(
      <PlanModal plan={makePlan()} isOpen={false} onClose={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders plan entries when open', () => {
    render(<PlanModal plan={makePlan()} isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(screen.getByText('Step 2')).toBeTruthy();
    expect(screen.getByText('Step 3')).toBeTruthy();
  });

  it('shows completion count in header', () => {
    render(<PlanModal plan={makePlan()} isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('1 of 3 complete')).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<PlanModal plan={makePlan()} isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close plan'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    const { container } = render(
      <PlanModal plan={makePlan()} isOpen={true} onClose={onClose} />
    );
    // Backdrop is the first child div inside the dialog
    const backdrop = container.querySelector('[role="dialog"] > div');
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<PlanModal plan={makePlan()} isOpen={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has dialog role and aria-modal', () => {
    render(<PlanModal plan={makePlan()} isOpen={true} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Agent plan progress');
  });

  it('renders completed entries with strikethrough', () => {
    const plan = makePlan([
      { content: 'Done step', priority: 'high', status: 'completed' },
    ]);
    render(<PlanModal plan={plan} isOpen={true} onClose={vi.fn()} />);
    const el = screen.getByText('Done step');
    expect(el.className).toContain('line-through');
  });

  it('renders in-progress entries with pulsing dot', () => {
    const plan = makePlan([
      { content: 'Working', priority: 'high', status: 'in_progress' },
    ]);
    const { container } = render(
      <PlanModal plan={plan} isOpen={true} onClose={vi.fn()} />
    );
    const pulseDot = container.querySelector('.animate-pulse');
    expect(pulseDot).toBeTruthy();
  });

  it('shows 0 of N complete for all pending', () => {
    const plan = makePlan([
      { content: 'A', priority: 'high', status: 'pending' },
      { content: 'B', priority: 'high', status: 'pending' },
    ]);
    render(<PlanModal plan={plan} isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('0 of 2 complete')).toBeTruthy();
  });

  it('shows all complete for fully done plan', () => {
    const plan = makePlan([
      { content: 'A', priority: 'high', status: 'completed' },
      { content: 'B', priority: 'high', status: 'completed' },
    ]);
    render(<PlanModal plan={plan} isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('2 of 2 complete')).toBeTruthy();
  });
});
