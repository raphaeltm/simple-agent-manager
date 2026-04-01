import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listGcpProjects: vi.fn(),
  runGcpSetup: vi.fn(),
  deleteCredential: vi.fn(),
  getGcpOAuthResult: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  listGcpProjects: mocks.listGcpProjects,
  runGcpSetup: mocks.runGcpSetup,
  deleteCredential: mocks.deleteCredential,
  getGcpOAuthResult: mocks.getGcpOAuthResult,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { GcpCredentialForm } from '../../../src/components/GcpCredentialForm';

const credential = {
  id: 'cred_gcp_01',
  provider: 'gcp' as const,
  connected: true,
  createdAt: '2026-03-20T00:00:00.000Z',
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
    // Reset URL params
    window.history.replaceState({}, '', window.location.pathname);
  });

  describe('idle state', () => {
    it('renders connect button when no credential', () => {
      render(<GcpCredentialForm onUpdate={onUpdate} />);

      expect(screen.getByText(/Connect your Google Cloud account/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Google Cloud' })).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: 'Confirm Disconnect' })).toBeInTheDocument();
    });

    it('calls deleteCredential when disconnect is confirmed via dialog', async () => {
      render(<GcpCredentialForm credential={credential} onUpdate={onUpdate} />);

      // Click Disconnect to open dialog
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      // Confirm in dialog
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Disconnect' }));

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
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Disconnect' }));

      await waitFor(() => {
        expect(screen.getByText('Delete failed')).toBeInTheDocument();
      });
      expect(onUpdate).not.toHaveBeenCalled();
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
        expect(screen.getByRole('button', { name: 'Connect Google Cloud' })).toBeInTheDocument();
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
        expect(screen.getByRole('button', { name: 'Connect Google Cloud' })).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('shows error when returning from OAuth with gcp_error param', () => {
      window.history.replaceState({}, '', '?gcp_error=access_denied');

      render(<GcpCredentialForm onUpdate={onUpdate} />);

      expect(screen.getByText('Google OAuth failed: access_denied')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Google Cloud' })).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole('button', { name: 'Connect Google Cloud' }));

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
      fireEvent.click(screen.getByRole('button', { name: 'Connect Google Cloud' }));

      // Should show error and return to zone-select for retry
      await waitFor(() => {
        expect(screen.getByText('IAM quota exceeded')).toBeInTheDocument();
      });
      // Connect button should still be present (zone-select phase allows retry)
      expect(screen.getByRole('button', { name: 'Connect Google Cloud' })).toBeInTheDocument();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });
});
