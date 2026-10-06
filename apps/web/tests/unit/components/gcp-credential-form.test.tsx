import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listGcpProjects: vi.fn(),
  runGcpSetup: vi.fn(),
  deleteCredential: vi.fn(),
  getGcpOAuthResult: vi.fn(),
  saveGcpServiceAccountCredential: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listGcpProjects: mocks.listGcpProjects,
  runGcpSetup: mocks.runGcpSetup,
  deleteCredential: mocks.deleteCredential,
  getGcpOAuthResult: mocks.getGcpOAuthResult,
  saveGcpServiceAccountCredential: mocks.saveGcpServiceAccountCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: mocks.toastError }),
}));

import { GcpCredentialForm } from '../../../src/components/GcpCredentialForm';

const credential = {
  id: 'cred_gcp_01',
  provider: 'gcp' as const,
  connected: true,
  createdAt: '2026-03-20T00:00:00.000Z',
  gcp: {
    authType: 'workload-identity' as const,
    gcpProjectId: 'proj-1',
    serviceAccountEmail: 'sam-wif@proj-1.iam.gserviceaccount.com',
    defaultZone: 'us-central1-a',
  },
};

const serviceAccountCredential = {
  ...credential,
  gcp: {
    authType: 'service-account-key' as const,
    gcpProjectId: 'proj-long-name-世界',
    serviceAccountEmail: 'sam-vm-manager@proj-long-name.iam.gserviceaccount.com',
    defaultZone: 'europe-west3-a',
    privateKeyId: '0123456789abcdef0123456789abcdef01234567',
  },
};

const gcpProjects = [
  { projectId: 'proj-1', name: 'My Project 1', projectNumber: '123' },
  { projectId: 'proj-2', name: 'My Project 2', projectNumber: '456' },
];

describe('GcpCredentialForm', () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGcpOAuthResult.mockResolvedValue({ handle: 'test-handle' });
    mocks.listGcpProjects.mockResolvedValue({ projects: gcpProjects });
    mocks.runGcpSetup.mockResolvedValue({ success: true, verified: true });
    mocks.deleteCredential.mockResolvedValue({});
    mocks.saveGcpServiceAccountCredential.mockResolvedValue({
      success: true,
      credential: serviceAccountCredential,
    });
    // Reset URL params
    window.history.replaceState({}, '', window.location.pathname);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  describe('idle state', () => {
    it('renders connect button when no credential', () => {
      render(<GcpCredentialForm onUpdate={onUpdate} />);

      expect(screen.getByText('Workload Identity Federation')).toBeInTheDocument();
      expect(screen.getByText('Recommended')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Use service account JSON' })).toBeInTheDocument();
    });
  });

  describe('connected state', () => {
    it('renders connected panel when credential exists', () => {
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    });

    it('shows ConfirmDialog on Disconnect click instead of window.confirm', () => {
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

      // ConfirmDialog should be open with the title
      expect(screen.getByText('Disconnect Google Cloud?')).toBeInTheDocument();
      expect(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' })
      ).toBeInTheDocument();
    });

    it('calls deleteCredential when disconnect is confirmed via dialog', async () => {
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      // Click Disconnect to open dialog
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      // Confirm in dialog
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' })
      );

      await waitFor(() => {
        expect(mocks.deleteCredential).toHaveBeenCalledWith('gcp');
      });
      expect(onUpdate).toHaveBeenCalled();
    });

    it('does not call deleteCredential when disconnect dialog is cancelled', () => {
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      // Click Disconnect to open dialog
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      // Cancel the dialog
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mocks.deleteCredential).not.toHaveBeenCalled();
    });

    it('shows error when disconnect fails', async () => {
      mocks.deleteCredential.mockRejectedValue(new Error('Delete failed'));
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' })
      );

      await waitFor(() => {
        expect(screen.getByText('Delete failed')).toBeInTheDocument();
      });
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('service-account credential', () => {
    it('keeps WIF recommended and saves pasted JSON without retaining it after success', async () => {
      render(<GcpCredentialForm onUpdate={onUpdate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Use service account JSON' }));

      expect(
        screen.getByText(/Google recommends Workload Identity Federation/)
      ).toBeInTheDocument();
      expect(screen.getByText(/Project Owner is not required/)).toBeInTheDocument();

      const json = '{"type":"service_account","private_key":"secret-value"}';
      fireEvent.change(screen.getByLabelText('Or paste JSON'), { target: { value: json } });
      fireEvent.change(screen.getByLabelText('Default zone'), {
        target: { value: 'europe-west3-a' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Validate and connect' }));

      await waitFor(() => {
        expect(mocks.saveGcpServiceAccountCredential).toHaveBeenCalledWith({
          serviceAccountJson: json,
          defaultZone: 'europe-west3-a',
        });
      });
      expect(onUpdate).toHaveBeenCalled();
      expect(screen.queryByDisplayValue(json)).not.toBeInTheDocument();
      expect(screen.queryByText('secret-value')).not.toBeInTheDocument();
    });

    it('reads a selected local JSON file into the unsaved form', async () => {
      render(<GcpCredentialForm onUpdate={onUpdate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Use service account JSON' }));

      const json = '{"type":"service_account","client_email":"sam@example.invalid"}';
      const file = new File([json], 'sam-key.json', { type: 'application/json' });
      Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(json) });
      fireEvent.change(screen.getByLabelText('Choose JSON file'), { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByLabelText('Or paste JSON')).toHaveValue(json);
      });
    });

    it('shows a retryable sanitized server error', async () => {
      mocks.saveGcpServiceAccountCredential.mockRejectedValue(new Error('Compute API is disabled'));
      render(<GcpCredentialForm onUpdate={onUpdate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Use service account JSON' }));
      fireEvent.change(screen.getByLabelText('Or paste JSON'), { target: { value: '{}' } });
      fireEvent.click(screen.getByRole('button', { name: 'Validate and connect' }));

      await waitFor(() => {
        expect(screen.getByText('Compute API is disabled')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Validate and connect' })).toBeInTheDocument();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('shows safe metadata and requires confirmation before rotation', async () => {
      render(<GcpCredentialForm credential={serviceAccountCredential} onUpdate={onUpdate} />);

      expect(screen.getByText('Service account JSON (long-lived key)')).toBeInTheDocument();
      expect(screen.getByText(serviceAccountCredential.gcp.gcpProjectId)).toBeInTheDocument();
      expect(
        screen.getByText(serviceAccountCredential.gcp.serviceAccountEmail)
      ).toBeInTheDocument();
      expect(screen.getByText(serviceAccountCredential.gcp.privateKeyId)).toBeInTheDocument();
      expect(screen.queryByText(/BEGIN PRIVATE KEY/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Rotate JSON key' }));
      expect(screen.getByLabelText('Or paste JSON')).toHaveValue('');
      expect(screen.getByLabelText('Default zone')).toHaveValue('europe-west3-a');
      fireEvent.change(screen.getByLabelText('Or paste JSON'), {
        target: { value: '{"new":true}' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Validate and rotate key' }));

      expect(
        screen.getByRole('dialog', { name: 'Rotate GCP service-account key?' })
      ).toBeInTheDocument();
      expect(mocks.saveGcpServiceAccountCredential).not.toHaveBeenCalled();
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Validate and rotate' })
      );

      await waitFor(() => {
        expect(mocks.saveGcpServiceAccountCredential).toHaveBeenCalledWith({
          serviceAccountJson: '{"new":true}',
          defaultZone: 'europe-west3-a',
        });
      });
    });

    it('reports clipboard failures without an unhandled rejection', async () => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'));
      render(<GcpCredentialForm onUpdate={onUpdate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Use service account JSON' }));
      fireEvent.click(screen.getByRole('button', { name: 'Copy commands' }));

      await waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalledWith('Could not copy gcloud commands');
      });
    });

    it('explains that disconnect does not revoke the Google-managed key', () => {
      render(<GcpCredentialForm credential={serviceAccountCredential} onUpdate={onUpdate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

      expect(
        screen.getByText(/will not delete or revoke a service-account key in Google Cloud/)
      ).toBeInTheDocument();
    });
  });
  describe('OAuth redirect loading state', () => {
    it('shows loading spinner when returning from OAuth', async () => {
      // Simulate OAuth callback URL
      window.history.replaceState({}, '', '?gcp_setup=1');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      // Should show loading state immediately, not jump to project select
      expect(screen.getByText('Loading GCP projects...')).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();

      // After OAuth result + projects load, should transition to project selection
      await waitFor(() => {
        expect(screen.getByText('Select a GCP project to connect:')).toBeInTheDocument();
      });

      expect(mocks.getGcpOAuthResult).toHaveBeenCalled();
      expect(mocks.listGcpProjects).toHaveBeenCalledWith('test-handle');
    });

    it('returns to idle with error on OAuth result failure', async () => {
      mocks.getGcpOAuthResult.mockRejectedValue(new Error('Session expired'));
      window.history.replaceState({}, '', '?gcp_setup=1');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      // Should show loading initially
      expect(screen.getByText('Loading GCP projects...')).toBeInTheDocument();

      // After failure, should return to idle with error and connect button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
        expect(screen.getByText('Session expired')).toBeInTheDocument();
      });
    });

    it('returns to idle with error on project fetch failure', async () => {
      mocks.listGcpProjects.mockRejectedValue(new Error('Network error'));
      window.history.replaceState({}, '', '?gcp_setup=1');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      // Should show loading initially
      expect(screen.getByText('Loading GCP projects...')).toBeInTheDocument();

      // After failure, should return to idle with error and connect button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('shows error when returning from OAuth with gcp_error param', () => {
      window.history.replaceState({}, '', '?gcp_error=access_denied');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      expect(screen.getByText('Google OAuth failed: access_denied')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
      expect(mocks.getGcpOAuthResult).not.toHaveBeenCalled();
    });
  });

  describe('setup completion transition', () => {
    it('transitions to idle after setup success so connected state renders', async () => {
      window.history.replaceState({}, '', '?gcp_setup=1');

      const { rerender } = render(<GcpCredentialForm onUpdate={onUpdate} />);

      // Wait for projects to load
      await waitFor(() => {
        expect(screen.getByText('Select a GCP project to connect:')).toBeInTheDocument();
      });

      // Select a project
      fireEvent.change(screen.getByLabelText('GCP Project'), { target: { value: 'proj-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));

      // Zone select phase — click connect
      fireEvent.click(screen.getByRole('button', { name: 'Connect with WIF' }));

      // Wait for setup to complete
      await waitFor(() => {
        expect(mocks.runGcpSetup).toHaveBeenCalled();
      });
      expect(onUpdate).toHaveBeenCalled();

      // Simulate parent re-rendering with credential after onUpdate
      rerender(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      // Should show connected state (not a dead-end "done" alert)
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('shows error and allows retry when setup fails', async () => {
      mocks.runGcpSetup.mockRejectedValue(new Error('IAM quota exceeded'));
      window.history.replaceState({}, '', '?gcp_setup=1');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      // Wait for projects to load
      await waitFor(() => {
        expect(screen.getByText('Select a GCP project to connect:')).toBeInTheDocument();
      });

      // Select project and zone, then attempt setup
      fireEvent.change(screen.getByLabelText('GCP Project'), { target: { value: 'proj-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Connect with WIF' }));

      // Should show error and return to zone-select for retry
      await waitFor(() => {
        expect(screen.getByText('IAM quota exceeded')).toBeInTheDocument();
      });
      // Connect button should still be present (zone-select phase allows retry)
      expect(screen.getByRole('button', { name: 'Connect with WIF' })).toBeInTheDocument();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });
});
