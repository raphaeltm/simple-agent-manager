import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CreateDirectoryDialog } from '../../../../src/components/library/CreateDirectoryDialog';

describe('CreateDirectoryDialog', () => {
  it('renders dialog with role and aria-modal', () => {
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The dim backdrop is a decorative sibling of the dialog card (not the
    // dialog element itself), so it can be aria-hidden without hiding the
    // real dialog content — see jsx-a11y/no-noninteractive-element-interactions.
    const backdrop = screen.getByTestId('create-directory-backdrop');
    expect(backdrop).toHaveClass('glass-backdrop-dim');
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(dialog.querySelector('.glass-modal')).toBeInTheDocument();
    expect(screen.getByText('New Folder')).toBeInTheDocument();
  });

  it('shows error when submitting empty name', async () => {
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('shows error for invalid characters', async () => {
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/Creating in/), '!!invalid!!');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name can only contain');
  });

  it('calls onCreated with correct path on valid submission', async () => {
    const onCreated = vi.fn();
    render(
      <CreateDirectoryDialog
        currentDirectory="/marketing/"
        onCreated={onCreated}
        onClose={vi.fn()}
      />
    );

    await userEvent.type(screen.getByLabelText(/Creating in/), 'brand');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreated).toHaveBeenCalledWith('/marketing/brand/');
  });

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={onClose} />);

    await userEvent.click(screen.getByTestId('create-directory-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose when clicking inside the dialog card', async () => {
    const onClose = vi.fn();
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={onClose} />);

    await userEvent.click(screen.getByText('New Folder'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clears error when input changes', async () => {
    render(<CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />);

    // Trigger error
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Type something — error should clear
    await userEvent.type(screen.getByLabelText(/Creating in/), 'a');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
