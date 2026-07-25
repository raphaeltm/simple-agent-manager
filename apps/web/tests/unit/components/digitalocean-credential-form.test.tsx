import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  validateCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCredential: mocks.createCredential,
  deleteCredential: mocks.deleteCredential,
  validateCredential: mocks.validateCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), addToast: vi.fn() }),
}));

import { DigitalOceanCredentialForm } from '../../../src/components/DigitalOceanCredentialForm';

const credential = {
  id: 'cred_digitalocean_01',
  provider: 'digitalocean' as const,
  connected: true,
  createdAt: '2026-07-23T00:00:00.000Z',
};

function fillToken(value = 'digitalocean-secret-key') {
  fireEvent.change(screen.getByLabelText('DigitalOcean API Key'), { target: { value } });
}

function fillAndConnect(value = 'digitalocean-secret-key') {
  fillToken(value);
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

async function expectAlertText(text: string) {
  await waitFor(() => {
    expect(screen.getByText(text)).toBeInTheDocument();
  });
}

describe('DigitalOceanCredentialForm', () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({});
    mocks.deleteCredential.mockResolvedValue({});
    mocks.validateCredential.mockResolvedValue({ valid: true, message: 'DigitalOcean credential validated.' });
  });

  it('renders the add-form with the DigitalOcean API Key input when no credential', () => {
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    expect(screen.getByLabelText('DigitalOcean API Key')).toBeInTheDocument();
    // Both actions are disabled until a token is entered.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });

  it('enables the actions once a token is entered', () => {
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillToken();

    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('calls createCredential with the digitalocean token payload on submit', async () => {
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillAndConnect('digitalocean-secret-key');

    await waitFor(() => {
      expect(mocks.createCredential).toHaveBeenCalledWith({ provider: 'digitalocean', token: 'digitalocean-secret-key' });
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows the validation success message when save validation passes', async () => {
    mocks.createCredential.mockResolvedValue({
      validation: { valid: true, message: 'DigitalOcean key accepted by provider.', validationMode: 'provider' },
    });
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillAndConnect('good-key');

    await expectAlertText('DigitalOcean key accepted by provider.');
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows a saved-with-warning message when save validation reports valid:false', async () => {
    mocks.createCredential.mockResolvedValue({
      validation: {
        valid: false,
        message: 'Token rejected by DigitalOcean API (401 Unauthorized)',
        error: 'Token rejected by DigitalOcean API (401 Unauthorized)',
        validationMode: 'provider',
      },
    });
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillAndConnect('bad-key');

    await expectAlertText('Saved, but Token rejected by DigitalOcean API (401 Unauthorized)');
    // valid:false is a soft warning — the credential is still saved, so onUpdate fires.
    expect(onUpdate).toHaveBeenCalled();
  });

  it('shows an error alert when the submit request throws', async () => {
    mocks.createCredential.mockRejectedValue(new Error('Invalid key'));
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillAndConnect('bad');

    await expectAlertText('Invalid key');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('validates via Test connection and shows the validated message', async () => {
    mocks.validateCredential.mockResolvedValue({ valid: true, message: 'DigitalOcean key is valid.' });
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillToken('valid-key');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(mocks.validateCredential).toHaveBeenCalledWith({ provider: 'digitalocean', token: 'valid-key' });
    });
    await expectAlertText('DigitalOcean key is valid.');
    // The validate button flips to "Tested" once the current token is validated.
    expect(screen.getByRole('button', { name: 'Tested' })).toBeInTheDocument();
    // createCredential is NOT called by a validate-only action.
    expect(mocks.createCredential).not.toHaveBeenCalled();
  });

  it('shows an error alert when Test connection validation throws', async () => {
    mocks.validateCredential.mockRejectedValue(new Error('Token rejected by DigitalOcean API (401 Unauthorized)'));
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    fillToken('bogus-key');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await expectAlertText('Token rejected by DigitalOcean API (401 Unauthorized)');
    // Failed validation must NOT flip the button to the validated ("Tested") state.
    expect(screen.queryByRole('button', { name: 'Tested' })).not.toBeInTheDocument();
  });

  it('ignores a stale validate response after the token changes mid-flight', async () => {
    // Race guard: handleValidate captures requestToken and compares latestToken.current
    // (updated on every render) before applying the result. A response for the OLD token
    // must be discarded once the user has typed a new one.
    let resolveValidate: ((value: { valid: boolean; message: string }) => void) | undefined;
    mocks.validateCredential.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveValidate = resolve;
        })
    );
    render(<DigitalOceanCredentialForm onUpdate={onUpdate} />);

    const input = screen.getByLabelText('DigitalOcean API Key');
    fireEvent.change(input, { target: { value: 'token-A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    // Validation for token-A is in flight — change the token before it resolves.
    fireEvent.change(input, { target: { value: 'token-B' } });

    // Now resolve the stale (token-A) validation.
    await act(async () => {
      resolveValidate?.({ valid: true, message: 'stale-token-A-validated' });
    });

    // The stale response must be ignored: its message must NOT surface...
    expect(screen.queryByText('stale-token-A-validated')).not.toBeInTheDocument();
    // ...and the validate button must NOT flip to "Tested" for the new (unvalidated) token.
    expect(screen.queryByRole('button', { name: 'Tested' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    // The in-flight request was made against the original token only.
    expect(mocks.validateCredential).toHaveBeenCalledWith({ provider: 'digitalocean', token: 'token-A' });
  });

  it('renders the connected panel when a credential exists', () => {
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    // The add-form input is not shown while connected.
    expect(screen.queryByLabelText('DigitalOcean API Key')).not.toBeInTheDocument();
  });

  it('switches to the edit form on Update click', () => {
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(screen.getByLabelText('DigitalOcean API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Cancel returns to the connected panel without any API call', () => {
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(mocks.createCredential).not.toHaveBeenCalled();
    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('calls deleteCredential("digitalocean") on Disconnect after confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(mocks.deleteCredential).toHaveBeenCalledWith('digitalocean');
    });
    expect(onUpdate).toHaveBeenCalled();
  });

  it('does not call deleteCredential when confirm is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(mocks.deleteCredential).not.toHaveBeenCalled();
  });

  it('shows an error alert on disconnect failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.deleteCredential.mockRejectedValue(new Error('Delete failed'));
    render(<DigitalOceanCredentialForm credential={credential} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    await expectAlertText('Delete failed');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
