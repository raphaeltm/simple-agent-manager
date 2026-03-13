import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  createCredential: mocks.createCredential,
  deleteCredential: mocks.deleteCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { ScalewayCredentialForm } from '../../../src/components/ScalewayCredentialForm';

const credential = {
  id: 'cred_02',
  provider: 'scaleway' as const,
  connected: true,
  createdAt: '2026-03-13T00:00:00.000Z',
};

describe('ScalewayCredentialForm', () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({});
    mocks.deleteCredential.mockResolvedValue({});
  });

  it('renders form with secret key and project ID inputs when no credential', () => {
    render(<ScalewayCredentialForm onUpdate={onUpdate} />);

    expect(screen.getByLabelText('API Secret Key')).toBeInTheDocument();
    expect(screen.getByLabelText('Project ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('enables submit button when both fields are filled', () => {
    render(<ScalewayCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('API Secret Key'), { target: { value: 'scw-key' } });
    fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'proj-123' } });

    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('keeps submit disabled when only one field is filled', () => {
    render(<ScalewayCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('API Secret Key'), { target: { value: 'scw-key' } });

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('calls createCredential with correct payload on submit', async () => {
    render(<ScalewayCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('API Secret Key'), { target: { value: 'my-secret' } });
    fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'proj-abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.createCredential).toHaveBeenCalledWith({
        provider: 'scaleway',
        secretKey: 'my-secret',
        projectId: 'proj-abc',
      });
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows error alert on submit failure', async () => {
    mocks.createCredential.mockRejectedValue(new Error('Invalid key'));
    render(<ScalewayCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('API Secret Key'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'proj' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid key')).toBeInTheDocument();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('renders connected panel when credential exists', () => {
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Scaleway credentials' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect Scaleway account' })).toBeInTheDocument();
  });

  it('switches to form on Update click', () => {
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update Scaleway credentials' }));

    expect(screen.getByLabelText('API Secret Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Credentials' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel returns to connected panel without API call', () => {
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update Scaleway credentials' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(mocks.createCredential).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('calls deleteCredential on Disconnect after confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Scaleway account' }));

    await waitFor(() => {
      expect(mocks.deleteCredential).toHaveBeenCalledWith('scaleway');
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('does not call deleteCredential when confirm is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Scaleway account' }));

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('shows error alert on disconnect failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.deleteCredential.mockRejectedValue(new Error('Delete failed'));
    render(<ScalewayCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Scaleway account' }));

    await waitFor(() => {
      expect(screen.getByText('Delete failed')).toBeInTheDocument();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
