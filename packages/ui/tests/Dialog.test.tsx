import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from '../src/components/Dialog';

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Dialog isOpen={false} onClose={vi.fn()}>
        <p>Hidden content</p>
      </Dialog>,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders into a portal on document.body when open', () => {
    const { container } = render(
      <div data-testid="parent-container">
        <Dialog isOpen={true} onClose={vi.fn()}>
          <p>Modal content</p>
        </Dialog>
      </div>,
    );
    // The dialog should NOT be a child of the parent container
    const parent = screen.getByTestId('parent-container');
    expect(parent.querySelector('[role="dialog"]')).toBeNull();

    // It should exist on document.body
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.closest('body')).toBe(document.body);
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('uses fixed positioning for the dialog wrapper', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('inset-0');
  });

  it('applies backdrop blur class on the overlay', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    // The overlay is the first child with glass-backdrop-dim
    const overlay = dialog.querySelector('.glass-backdrop-dim');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toContain('fixed');
    expect(overlay!.className).toContain('inset-0');
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Dialog isOpen={true} onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );
    const overlay = screen.getByRole('dialog').querySelector('.glass-backdrop-dim');
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Dialog isOpen={true} onClose={onClose}>
        <p>Content</p>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when clicking the dialog panel itself', () => {
    const onClose = vi.fn();
    render(
      <Dialog isOpen={true} onClose={onClose}>
        <p>Panel content</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText('Panel content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('locks body scroll when open and restores on close', () => {
    const { rerender } = render(
      <Dialog isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <Dialog isOpen={false} onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe('');
  });

  it('applies the correct maxWidth class', () => {
    const { rerender } = render(
      <Dialog isOpen={true} onClose={vi.fn()} maxWidth="sm">
        <p>Small</p>
      </Dialog>,
    );
    let dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.max-w-sm')).not.toBeNull();

    rerender(
      <Dialog isOpen={true} onClose={vi.fn()} maxWidth="lg">
        <p>Large</p>
      </Dialog>,
    );
    dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.max-w-xl')).not.toBeNull();
  });

  it('has a scrollable content area with max height constraint', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()}>
        <p>Scrollable content</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    // The panel should have max-h constraint
    const panel = dialog.querySelector('.max-h-\\[calc\\(100dvh-2rem\\)\\]');
    expect(panel).not.toBeNull();
    // The inner content area should have overflow-y-auto
    const scrollArea = dialog.querySelector('.overflow-y-auto');
    expect(scrollArea).not.toBeNull();
  });

  it('cleans up body overflow style on unmount', () => {
    const { unmount } = render(
      <Dialog isOpen={true} onClose={vi.fn()}>
        <p>Content</p>
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
