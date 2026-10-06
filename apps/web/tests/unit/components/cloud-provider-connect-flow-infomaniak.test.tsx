import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  saveProjectCloudCredential: vi.fn(),
}));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  ...mocks,
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
import { CloudProviderConnectFlow } from '../../../src/components/CloudProviderConnectFlow';

function fill() {
  fireEvent.click(screen.getByRole('button', { name: /Infomaniak Public Cloud/ }));
  fireEvent.change(screen.getByLabelText('Application credential ID'), {
    target: { value: 'app-id' },
  });
  fireEvent.change(screen.getByLabelText(/Application credential secret/), {
    target: { value: 'app-secret' },
  });
}

describe('CloudProviderConnectFlow — Infomaniak branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({});
    mocks.saveProjectCloudCredential.mockResolvedValue({});
  });

  it('requires both explicitly labeled application credential fields', () => {
    render(<CloudProviderConnectFlow />);
    fireEvent.click(screen.getByRole('button', { name: /Infomaniak Public Cloud/ }));
    expect(screen.getByLabelText('Application credential ID')).toBeInTheDocument();
    expect(screen.getByLabelText(/Application credential secret/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/GCP project ID/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Application credential ID'), {
      target: { value: 'app-id' },
    });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Application credential secret/), {
      target: { value: 'app-secret' },
    });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('submits the Infomaniak payload without GCP or Scaleway fallthrough fields', async () => {
    render(<CloudProviderConnectFlow />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(mocks.createCredential).toHaveBeenCalledWith({
        provider: 'infomaniak',
        applicationCredentialId: 'app-id',
        applicationCredentialSecret: 'app-secret',
      })
    );
    const payload = mocks.createCredential.mock.calls[0][0];
    expect(payload).not.toHaveProperty('gcpProjectId');
    expect(payload).not.toHaveProperty('secretKey');
    expect(payload).not.toHaveProperty('token');
  });
});
