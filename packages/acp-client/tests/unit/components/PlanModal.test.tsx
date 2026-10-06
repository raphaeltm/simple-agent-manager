import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanModal } from '../../../src/components/PlanModal';
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

function renderModal(overrides: { plan?: PlanItem; isOpen?: boolean } = {}) {
  const onClose = vi.fn();
  const result = render(
    <PlanModal
      plan={overrides.plan ?? makePlan()}
      isOpen={overrides.isOpen ?? true}
      onClose={onClose}
    />
  );
  return { ...result, onClose };
}

describe('PlanModal', () => {
  it('renders nothing when not open', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container.innerHTML).toBe('');
  });

  it('renders plan entries when open', () => {
    renderModal();
    expect(screen.getByText('Step 1')).toBeTruthy();
    expect(screen.getByText('Step 2')).toBeTruthy();
    expect(screen.getByText('Step 3')).toBeTruthy();
  });

  it('shows completion count in header', () => {
    renderModal();
    expect(screen.getByText('1 of 3 complete')).toBeTruthy();
  });

  it('calls onClose when close button clicked', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText('Close plan'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop clicked', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText('Close plan overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape key', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has dialog role and aria-modal', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Agent plan progress');
  });

  it('renders completed entries with strikethrough', () => {
    renderModal({
      plan: makePlan([{ content: 'Done step', priority: 'high', status: 'completed' }]),
    });
    const el = screen.getByText('Done step');
    expect(el.style.textDecoration).toBe('line-through');
  });

  it('renders in-progress entries with glow', () => {
    renderModal({
      plan: makePlan([{ content: 'Working', priority: 'high', status: 'in_progress' }]),
    });
    const el = screen.getByText('Working');
    const dot = el.previousElementSibling as HTMLElement;
    expect(dot.style.boxShadow).toContain('rgba(34, 197, 94');
  });

  it('shows 0 of N complete for all pending', () => {
    renderModal({
      plan: makePlan([
        { content: 'A', priority: 'high', status: 'pending' },
        { content: 'B', priority: 'high', status: 'pending' },
      ]),
    });
    expect(screen.getByText('0 of 2 complete')).toBeTruthy();
  });

  it('shows all complete for fully done plan', () => {
    renderModal({
      plan: makePlan([
        { content: 'A', priority: 'high', status: 'completed' },
        { content: 'B', priority: 'high', status: 'completed' },
      ]),
    });
    expect(screen.getByText('2 of 2 complete')).toBeTruthy();
  });

  it('renders a progress bar with correct aria attributes', () => {
    renderModal();
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('1');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('3');
  });

  it('prevents body scroll while open', () => {
    renderModal();
    expect(document.body.style.overflow).toBe('hidden');
  });
});
