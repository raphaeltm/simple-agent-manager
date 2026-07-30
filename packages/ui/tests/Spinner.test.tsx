import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { Spinner } from '../src/components/Spinner';

describe('Spinner', () => {
  it('is announced as a status by default', () => {
    render(<Spinner />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('is hidden from assistive technology when decorative', () => {
    // Used inside a button that already carries aria-busy; a labelled spinner
    // there would be concatenated into the button's accessible name.
    const { container } = render(<Spinner decorative />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const spinner = container.querySelector('[data-slot="spinner"]');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).not.toHaveAttribute('aria-label');
  });

  it('exposes a stable data-slot hook for tests and consumers', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('[data-slot="spinner"]')).toBeTruthy();
  });

  describe('tone', () => {
    it('defaults to the accent ring', () => {
      const { container } = render(<Spinner />);
      expect(container.querySelector('[data-slot="spinner"]')).toHaveClass('border-t-accent');
    });

    it('inherits text colour when tone is current', () => {
      // On a filled button (primary/danger) an accent ring can be invisible.
      const { container } = render(<Spinner tone="current" />);
      const spinner = container.querySelector('[data-slot="spinner"]');
      expect(spinner).toHaveClass('border-t-current');
      expect(spinner).not.toHaveClass('border-t-accent');
    });
  });

  describe('size', () => {
    it.each([
      ['sm', 'size-4'],
      ['md', 'size-6'],
      ['lg', 'size-8'],
    ] as const)('applies the %s size', (size, expectedClass) => {
      const { container } = render(<Spinner size={size} />);
      expect(container.querySelector('[data-slot="spinner"]')).toHaveClass(expectedClass);
    });
  });

  it('merges a caller className', () => {
    const { container } = render(<Spinner className="shrink-0" />);
    expect(container.querySelector('[data-slot="spinner"]')).toHaveClass('shrink-0');
  });
});
