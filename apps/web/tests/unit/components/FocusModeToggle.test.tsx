import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FocusModeToggle } from '../../../src/components/FocusModeToggle';

describe('FocusModeToggle', () => {
  describe('segmented variant', () => {
    it('marks the active mode with aria-pressed', () => {
      render(
        <FocusModeToggle
          mode="focus"
          onSelect={vi.fn()}
          onCycle={vi.fn()}
          variant="segmented"
        />,
      );
      const focusBtn = screen.getByRole('button', { name: 'Focus', pressed: true });
      expect(focusBtn).toBeInTheDocument();
      // The other two should not be pressed
      expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('calls onSelect with the chosen mode when a segment is clicked', () => {
      const onSelect = vi.fn();
      render(
        <FocusModeToggle
          mode="default"
          onSelect={onSelect}
          onCycle={vi.fn()}
          variant="segmented"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Zen' }));
      expect(onSelect).toHaveBeenCalledWith('zen');
    });

    it('calls onCycle when the cycle button is clicked', () => {
      const onCycle = vi.fn();
      render(
        <FocusModeToggle
          mode="default"
          onSelect={vi.fn()}
          onCycle={onCycle}
          variant="segmented"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cycle Focus Mode' }));
      expect(onCycle).toHaveBeenCalledTimes(1);
    });
  });

  describe('cycle variant', () => {
    it('calls onCycle when the compact button is clicked', () => {
      const onCycle = vi.fn();
      render(
        <FocusModeToggle
          mode="focus"
          onSelect={vi.fn()}
          onCycle={onCycle}
          variant="cycle"
        />,
      );
      // aria-label announces current + next mode
      fireEvent.click(
        screen.getByRole('button', {
          name: /Focus Mode: Focus\. Activate to switch to Zen/,
        }),
      );
      expect(onCycle).toHaveBeenCalledTimes(1);
    });
  });
});
