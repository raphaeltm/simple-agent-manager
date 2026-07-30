import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { Button } from '../src/components/Button';

describe('Button', () => {
  it('renders children and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('press affordance', () => {
    it('carries the sam-pressable class so a tap has visible feedback', () => {
      // Touch devices have no hover; without this class a press shows nothing.
      render(<Button>Press me</Button>);
      expect(screen.getByRole('button', { name: 'Press me' })).toHaveClass('sam-pressable');
    });

    it('keeps transition-all so sam-pressable does not strip colour easing', () => {
      // sam-pressable deliberately declares no `transition`; the shorthand
      // would reset this and snap every hover/disabled fade app-wide.
      render(<Button>Press me</Button>);
      expect(screen.getByRole('button', { name: 'Press me' })).toHaveClass('transition-all');
    });
  });

  describe('loading', () => {
    it('renders a spinner and marks the button busy without natively disabling it', () => {
      render(<Button loading>Archiving...</Button>);

      const button = screen.getByRole('button', { name: 'Archiving...' });
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button.querySelector('[data-slot="spinner"]')).toBeTruthy();
      // Native `disabled` would blur a focused button to <body> permanently.
      expect(button).not.toBeDisabled();
    });

    it('keeps focus when it becomes busy', () => {
      // The regression this guards: a keyboard user activates a button, the
      // handler sets loading, and focus silently jumps to <body> for good.
      const { rerender } = render(<Button>Archive</Button>);
      const button = screen.getByRole('button', { name: 'Archive' });
      button.focus();
      expect(button).toHaveFocus();

      rerender(<Button loading>Archive</Button>);
      expect(screen.getByRole('button', { name: 'Archive' })).toHaveFocus();
      expect(document.body).not.toHaveFocus();
    });

    it('keeps the spinner out of the accessible name', () => {
      // A labelled spinner would make this button "Loading Archiving...".
      render(<Button loading>Archiving...</Button>);

      expect(screen.getByRole('button', { name: 'Archiving...' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Loading/ })).not.toBeInTheDocument();
    });

    it('renders no spinner and no aria-busy when idle', () => {
      render(<Button>Archive</Button>);

      const button = screen.getByRole('button', { name: 'Archive' });
      expect(button).not.toHaveAttribute('aria-busy');
      expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
    });

    it('does not fire onClick while loading', () => {
      const onClick = vi.fn();
      render(
        <Button loading onClick={onClick}>
          Save
        </Button>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('sizes', () => {
    it.each([
      ['xs', 'min-h-7'],
      ['sm', 'min-h-9'],
      ['md', 'min-h-11'],
      ['lg', 'min-h-14'],
    ] as const)('applies the %s tier', (size, expectedClass) => {
      render(<Button size={size}>Sized</Button>);
      expect(screen.getByRole('button', { name: 'Sized' })).toHaveClass(expectedClass);
    });

    it('defaults to md', () => {
      render(<Button>Default</Button>);
      expect(screen.getByRole('button', { name: 'Default' })).toHaveClass('min-h-11');
    });
  });

  describe('variants', () => {
    it.each([
      ['primary', 'bg-accent'],
      ['secondary', 'bg-surface'],
      ['danger', 'bg-danger'],
      ['ghost', 'bg-transparent'],
    ] as const)('applies the %s variant', (variant, expectedClass) => {
      render(<Button variant={variant}>Styled</Button>);
      expect(screen.getByRole('button', { name: 'Styled' })).toHaveClass(expectedClass);
    });
  });

  it('honours an explicit disabled prop', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>
    );

    const button = screen.getByRole('button', { name: 'Nope' });
    expect(button).toBeDisabled();
    // Disabled without loading is not "busy".
    expect(button).not.toHaveAttribute('aria-busy');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
