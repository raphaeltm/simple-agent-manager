import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getProjectDeploymentGcp: vi.fn(),
  setupProjectDeploymentGcp: vi.fn(),
  deleteProjectDeploymentGcp: vi.fn(),
  listGcpProjectsForDeploy: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getProjectDeploymentGcp: mocks.getProjectDeploymentGcp,
  setupProjectDeploymentGcp: mocks.setupProjectDeploymentGcp,
  deleteProjectDeploymentGcp: mocks.deleteProjectDeploymentGcp,
  listGcpProjectsForDeploy: mocks.listGcpProjectsForDeploy,
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

import { DeploymentSettings } from '../../../src/components/DeploymentSettings';

function renderWithRouter(ui: React.ReactElement, { initialEntries = ['/settings'] } = {}) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      {ui}
    </MemoryRouter>
  );
}

describe('DeploymentSettings', () => {
  const projectId = 'proj-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectDeploymentGcp.mockResolvedValue({ connected: false });
  });

  describe('initial loading', () => {
    it('shows loading spinner while fetching deployment config', () => {
      mocks.getProjectDeploymentGcp.mockReturnValue(new Promise(() => {})); // never resolves
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      expect(screen.getByText('Loading deployment config...')).toBeInTheDocument();
    });

    it('shows "Connect Google Cloud" button when not configured', async () => {
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      await waitFor(() => {
        expect(screen.getByText('Connect Google Cloud')).toBeInTheDocument();
      });
    });
  });

  describe('connected state', () => {
    beforeEach(() => {
      mocks.getProjectDeploymentGcp.mockResolvedValue({
        connected: true,
        gcpProjectId: 'my-gcp-project',
        serviceAccountEmail: 'sa@my-gcp-project.iam.gserviceaccount.com',
      });
    });

    it('shows connected state with project and service account', async () => {
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      await waitFor(() => {
        expect(screen.getByText('GCP Connected')).toBeInTheDocument();
      });
      expect(screen.getByText('my-gcp-project')).toBeInTheDocument();
      expect(screen.getByText('sa@my-gcp-project.iam.gserviceaccount.com')).toBeInTheDocument();
    });

    it('shows inline disconnect confirmation instead of window.confirm', async () => {
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      // Click disconnect — should show inline confirmation, not window.confirm
      fireEvent.click(screen.getByText('Disconnect'));

      // Inline confirmation should appear
      expect(screen.getByText(/Disconnect GCP deployment credentials/)).toBeInTheDocument();
      expect(screen.getByText('Confirm Disconnect')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('can cancel the disconnect confirmation', async () => {
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Disconnect'));
      expect(screen.getByText('Confirm Disconnect')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));
      // Confirmation should be dismissed
      expect(screen.queryByText('Confirm Disconnect')).not.toBeInTheDocument();
    });

    it('executes disconnect when confirmed', async () => {
      mocks.deleteProjectDeploymentGcp.mockResolvedValue({});
      renderWithRouter(<DeploymentSettings projectId={projectId} />);
      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Disconnect'));
      fireEvent.click(screen.getByText('Confirm Disconnect'));

      await waitFor(() => {
        expect(mocks.deleteProjectDeploymentGcp).toHaveBeenCalledWith(projectId);
      });
      expect(mockToast.success).toHaveBeenCalledWith('GCP deployment disconnected');
    });
  });

  describe('OAuth callback with projects', () => {
    it('shows loading indicator while fetching GCP projects', async () => {
      mocks.listGcpProjectsForDeploy.mockReturnValue(new Promise(() => {})); // never resolves
      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_setup=handle-123'] }
      );

      await waitFor(() => {
        expect(screen.getByText('Loading GCP projects...')).toBeInTheDocument();
      });
    });

    it('shows project dropdown when projects are found', async () => {
      mocks.listGcpProjectsForDeploy.mockResolvedValue({
        projects: [
          { projectId: 'proj-a', name: 'Project A' },
          { projectId: 'proj-b', name: 'Project B' },
        ],
      });

      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_setup=handle-123'] }
      );

      await waitFor(() => {
        expect(screen.getByText('Select GCP Project')).toBeInTheDocument();
      });
      expect(screen.getByText('Project A (proj-a)')).toBeInTheDocument();
      expect(screen.getByText('Project B (proj-b)')).toBeInTheDocument();
      expect(screen.getByText('Set Up Deployment')).toBeInTheDocument();
    });
  });

  describe('empty GCP project list', () => {
    it('shows empty state with explanation and GCP Console link when no projects found', async () => {
      mocks.listGcpProjectsForDeploy.mockResolvedValue({ projects: [] });

      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_setup=handle-123'] }
      );

      await waitFor(() => {
        expect(screen.getByText(/No GCP projects found/)).toBeInTheDocument();
      });

      // Should have a link to GCP Console
      const link = screen.getByText('Google Cloud Console');
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute('href', 'https://console.cloud.google.com/projectcreate');
      expect(link.closest('a')).toHaveAttribute('target', '_blank');

      // Should have "Try Again" button
      expect(screen.getByText('Try Again')).toBeInTheDocument();
      // Should have "Cancel" button
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('does not show the project dropdown or "Set Up Deployment" when no projects', async () => {
      mocks.listGcpProjectsForDeploy.mockResolvedValue({ projects: [] });

      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_setup=handle-123'] }
      );

      await waitFor(() => {
        expect(screen.getByText(/No GCP projects found/)).toBeInTheDocument();
      });

      expect(screen.queryByText('Select GCP Project')).not.toBeInTheDocument();
      expect(screen.queryByText('Set Up Deployment')).not.toBeInTheDocument();
    });
  });

  describe('setup flow', () => {
    it('shows setting-up spinner during setup and transitions to connected', async () => {
      mocks.listGcpProjectsForDeploy.mockResolvedValue({
        projects: [{ projectId: 'proj-a', name: 'Project A' }],
      });
      mocks.setupProjectDeploymentGcp.mockResolvedValue({});
      mocks.getProjectDeploymentGcp
        .mockResolvedValueOnce({ connected: false }) // initial load
        .mockResolvedValueOnce({ connected: true, gcpProjectId: 'proj-a', serviceAccountEmail: 'sa@proj-a.iam' }); // after setup

      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_setup=handle-123'] }
      );

      await waitFor(() => {
        expect(screen.getByText('Set Up Deployment')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Set Up Deployment'));

      await waitFor(() => {
        expect(screen.getByText(/Creating WIF pool/)).toBeInTheDocument();
      });

      // After setup completes, should show connected state (no blank flash)
      await waitFor(() => {
        expect(screen.getByText('GCP Connected')).toBeInTheDocument();
      });
    });
  });

  describe('OAuth error', () => {
    it('shows toast on OAuth error', async () => {
      renderWithRouter(
        <DeploymentSettings projectId={projectId} />,
        { initialEntries: ['/settings?gcp_deploy_error=access_denied'] }
      );

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('GCP OAuth error: access_denied');
      });
    });
  });
});
