import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCredential: mocks.createCredential,
  deleteCredential: mocks.deleteCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    addToast: vi.fn(),
  }),
}));

import { InfomaniakCredentialForm } from '../../../src/components/InfomaniakCredentialForm';

const credential = {
  id: 'cred_02',
  provider: 'infomaniak' as const,
  connected: true,
  createdAt: '2026-03-13T00:00:00.000Z',
};

function submitInfomaniakForm(
  applicationCredentialSecret = 'my-secret',
  applicationCredentialId = 'proj-abc'
) {
  fireEvent.change(screen.getByLabelText('Application Credential Secret'), {
    target: { value: applicationCredentialSecret },
  });
  fireEvent.change(screen.getByLabelText('Application Credential ID'), {
    target: { value: applicationCredentialId },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

async function expectAlertText(text: string) {
  await waitFor(() => {
    expect(screen.getByText(text)).toBeInTheDocument();
  });
}

describe('InfomaniakCredentialForm', () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({});
    mocks.deleteCredential.mockResolvedValue({});
  });

  it('renders form with secret key and application credential ID inputs when no credential', () => {
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    expect(screen.getByLabelText('Application Credential Secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Application Credential ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('enables submit button when both fields are filled', () => {
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('Application Credential Secret'), {
      target: { value: 'scw-key' },
    });
    fireEvent.change(screen.getByLabelText('Application Credential ID'), {
      target: { value: 'proj-123' },
    });

    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('keeps submit disabled when only one field is filled', () => {
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    fireEvent.change(screen.getByLabelText('Application Credential Secret'), {
      target: { value: 'scw-key' },
    });

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('calls createCredential with correct payload on submit', async () => {
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    submitInfomaniakForm();

    await waitFor(() => {
      expect(mocks.createCredential).toHaveBeenCalledWith({
        provider: 'infomaniak',
        applicationCredentialSecret: 'my-secret',
        applicationCredentialId: 'proj-abc',
      });
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows validation success when save validation passes', async () => {
    mocks.createCredential.mockResolvedValue({
      validation: {
        valid: true,
        message: 'Infomaniak credential validated.',
        validationMode: 'provider',
      },
    });
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    submitInfomaniakForm('good-key');

    await expectAlertText('Infomaniak credential validated.');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows a saved warning when save validation fails', async () => {
    mocks.createCredential.mockResolvedValue({
      validation: {
        valid: false,
        message: 'Token rejected by Infomaniak API (401 Unauthorized)',
        error: 'Token rejected by Infomaniak API (401 Unauthorized)',
        validationMode: 'provider',
      },
    });
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    submitInfomaniakForm('bad-key');

    await expectAlertText('Saved, but Token rejected by Infomaniak API (401 Unauthorized)');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows error alert on submit failure', async () => {
    mocks.createCredential.mockRejectedValue(new Error('Invalid key'));
    render(<InfomaniakCredentialForm onUpdate={onUpdate} />);

    submitInfomaniakForm('bad', 'proj');

    await expectAlertText('Invalid key');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('renders connected panel when credential exists', () => {
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Update Infomaniak credentials' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Disconnect Infomaniak account' })
    ).toBeInTheDocument();
  });

  it('switches to form on Update click', () => {
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update Infomaniak credentials' }));

    expect(screen.getByLabelText('Application Credential Secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Credentials' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel returns to connected panel without API call', () => {
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update Infomaniak credentials' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(mocks.createCredential).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('calls deleteCredential on Disconnect after confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Infomaniak account' }));

    await waitFor(() => {
      expect(mocks.deleteCredential).toHaveBeenCalledWith('infomaniak');
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('does not call deleteCredential when confirm is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Infomaniak account' }));

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('shows error alert on disconnect failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.deleteCredential.mockRejectedValue(new Error('Delete failed'));
    render(<InfomaniakCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Infomaniak account' }));

    await waitFor(() => {
      expect(screen.getByText('Delete failed')).toBeInTheDocument();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
