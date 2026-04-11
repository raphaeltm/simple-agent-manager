import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CreateDirectoryDialog } from '../../../../src/components/library/CreateDirectoryDialog';

describe('CreateDirectoryDialog', () => {
  it('renders dialog with role and aria-modal', () => {
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('New Folder')).toBeInTheDocument();
  });

  it('shows error when submitting empty name', async () => {
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('shows error for invalid characters', async () => {
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/Creating in/), '!!invalid!!');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name can only contain');
  });

  it('calls onCreated with correct path on valid submission', async () => {
    const onCreated = vi.fn();
    render(
      <CreateDirectoryDialog currentDirectory="/marketing/" onCreated={onCreated} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/Creating in/), 'brand');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreated).toHaveBeenCalledWith('/marketing/brand/');
  });

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn();
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={onClose} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', async () => {
    const onClose = vi.fn();
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={onClose} />,
    );

    // Click the backdrop (the dialog wrapper div)
    const dialog = screen.getByRole('dialog');
    await userEvent.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it('clears error when input changes', async () => {
    render(
      <CreateDirectoryDialog currentDirectory="/" onCreated={vi.fn()} onClose={vi.fn()} />,
    );

    // Trigger error
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Type something — error should clear
    await userEvent.type(screen.getByLabelText(/Creating in/), 'a');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
