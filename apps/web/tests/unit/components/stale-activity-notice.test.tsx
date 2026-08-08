import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StaleActivityNotice } from '../../../src/components/project-message-view/StaleActivityNotice';

describe('StaleActivityNotice', () => {
  it('announces the stall as a status region with the notice text', () => {
    render(<StaleActivityNotice onDismiss={() => {}} />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Agent went quiet — no confirmed activity');
  });

  it('dismiss button invokes onDismiss', () => {
    const onDismiss = vi.fn();
    render(<StaleActivityNotice onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss is keyboard-reachable (native button)', () => {
    render(<StaleActivityNotice onDismiss={() => {}} />);
    const button = screen.getByRole('button', { name: 'Dismiss' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
  });
});
