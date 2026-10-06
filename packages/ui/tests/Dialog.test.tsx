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


  it('supports explicit accessible labels without a broken labelledby reference', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Archive conversation confirmation">
        <p>Confirm archive</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Archive conversation confirmation' });
    expect(dialog).toHaveAttribute('aria-label', 'Archive conversation confirmation');
    expect(dialog).not.toHaveAttribute('aria-labelledby');
  });

  it('uses provided labelledby and describedby ids', () => {
    render(
      <Dialog
        isOpen={true}
        onClose={vi.fn()}
        aria-labelledby="confirm-title"
        aria-describedby="confirm-copy"
      >
        <h2 id="confirm-title">Complete and delete?</h2>
        <p id="confirm-copy">This removes the workspace.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Complete and delete?' });
    expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'confirm-copy');
  });

  it('restores focus to the element that opened the dialog', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open dialog';
    document.body.appendChild(opener);
    opener.focus();

    const { rerender } = render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Focused dialog">
        <button type="button">Cancel</button>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Focused dialog' })).toBeInTheDocument();

    rerender(
      <Dialog isOpen={false} onClose={vi.fn()} aria-label="Focused dialog">
        <button type="button">Cancel</button>
      </Dialog>,
    );

    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps Tab focus inside the dialog', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Trap focus">
        <button type="button">Cancel</button>
        <button type="button">Confirm</button>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Trap focus' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();

    dialog.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
  });


  it('isolates and restores background siblings while open', () => {
    const background = document.createElement('main');
    background.setAttribute('aria-hidden', 'false');
    document.body.appendChild(background);

    const { unmount } = render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Isolated dialog">
        <button type="button">Confirm</button>
      </Dialog>,
    );

    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background.inert).toBe(true);

    unmount();

    expect(background).toHaveAttribute('aria-hidden', 'false');
    expect(background.inert).not.toBe(true);
    background.remove();
  });

  it('removes generated aria-hidden when restoring unlabelled background siblings', () => {
    const background = document.createElement('main');
    document.body.appendChild(background);

    const { unmount } = render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Temporary isolation">
        <button type="button">Confirm</button>
      </Dialog>,
    );

    expect(background).toHaveAttribute('aria-hidden', 'true');

    unmount();

    expect(background).not.toHaveAttribute('aria-hidden');
    background.remove();
  });

  it('skips hidden and inert controls when trapping focus', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} aria-label="Filtered focus">
        <button type="button" aria-hidden="true">Hidden action</button>
        <div inert>
          <button type="button">Inert action</button>
        </div>
        <button type="button">Visible action</button>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Filtered focus' });
    const visible = screen.getByRole('button', { name: 'Visible action' });

    dialog.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(visible).toHaveFocus();
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
