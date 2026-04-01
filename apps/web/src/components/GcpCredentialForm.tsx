import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Select, Spinner } from '@simple-agent-manager/ui';
import { useCallback,useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import type { GcpProject } from '../lib/api';
import { deleteCredential, getGcpOAuthResult,listGcpProjects, runGcpSetup } from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';

const GCP_ZONES = [
  { id: 'us-central1-a', label: 'Iowa (us-central1-a)' },
  { id: 'us-east1-b', label: 'South Carolina (us-east1-b)' },
  { id: 'us-west1-a', label: 'Oregon (us-west1-a)' },
  { id: 'europe-west1-b', label: 'Belgium (europe-west1-b)' },
  { id: 'europe-west3-a', label: 'Frankfurt (europe-west3-a)' },
  { id: 'europe-west2-a', label: 'London (europe-west2-a)' },
  { id: 'asia-southeast1-a', label: 'Singapore (asia-southeast1-a)' },
  { id: 'asia-northeast1-a', label: 'Tokyo (asia-northeast1-a)' },
];

const SETUP_STEPS = [
  { key: 'get_project_number', label: 'Getting project info' },
  { key: 'enable_apis', label: 'Enabling required APIs' },
  { key: 'create_wif_pool', label: 'Creating identity pool' },
  { key: 'create_oidc_provider', label: 'Configuring OIDC provider' },
  { key: 'create_service_account', label: 'Creating service account' },
  { key: 'grant_wif_user', label: 'Setting permissions' },
  { key: 'grant_project_roles', label: 'Granting compute & AI access' },
];

interface GcpCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

type SetupPhase = 'idle' | 'oauth' | 'loading-projects' | 'project-select' | 'zone-select' | 'setting-up';

export function GcpCredentialForm({ credential, onUpdate }: GcpCredentialFormProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SetupPhase>('idle');

  // OAuth handle from callback (opaque KV key, not the raw token)
  const [oauthHandle, setOauthHandle] = useState<string | null>(null);

  // Project selection
  const [projects, setProjects] = useState<GcpProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  // Zone selection
  const [selectedZone, setSelectedZone] = useState('us-central1-a');

  // Disconnect confirmation dialog
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Check for OAuth callback flag in URL — the handle is retrieved via an
  // authenticated API call to avoid leaking it in browser history / Referer headers.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setupFlag = params.get('gcp_setup');
    const gcpError = params.get('gcp_error');

    if (setupFlag) {
      // Show loading state immediately instead of jumping to project-select
      setPhase('loading-projects');
      // Clean up URL immediately
      const url = new URL(window.location.href);
      url.searchParams.delete('gcp_setup');
      window.history.replaceState({}, '', url.toString());

      // Retrieve handle via authenticated endpoint — keep loading-projects phase
      // so fetchProjects useEffect triggers when handle becomes available
      void getGcpOAuthResult()
        .then((result) => {
          setOauthHandle(result.handle);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Failed to retrieve OAuth result');
          setPhase('idle');
        });
    }

    if (gcpError) {
      setError(`Google OAuth failed: ${gcpError}`);
      const url = new URL(window.location.href);
      url.searchParams.delete('gcp_error');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  // Fetch projects when we have a handle
  const fetchProjects = useCallback(async () => {
    if (!oauthHandle) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listGcpProjects(oauthHandle);
      setProjects(result.projects);
      if (result.projects.length === 1 && result.projects[0]) {
        setSelectedProject(result.projects[0].projectId);
      }
      setPhase('project-select');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load GCP projects');
      setPhase('idle');
    } finally {
      setLoading(false);
    }
  }, [oauthHandle]);

  useEffect(() => {
    if (phase === 'loading-projects' && oauthHandle) {
      void fetchProjects();
    }
  }, [phase, oauthHandle, fetchProjects]);

  const handleConnectClick = () => {
    // Redirect to Google OAuth via our API
    const apiBase = window.location.origin.replace('app.', 'api.');
    window.location.href = `${apiBase}/auth/google/authorize`;
  };

  const handleProjectSelect = () => {
    if (!selectedProject) return;
    setPhase('zone-select');
  };

  const handleSetup = async () => {
    if (!oauthHandle || !selectedProject) return;

    setPhase('setting-up');
    setLoading(true);
    setError(null);

    try {
      const result = await runGcpSetup({
        oauthHandle,
        gcpProjectId: selectedProject,
        defaultZone: selectedZone,
      });

      if (result.success) {
        toast.success(result.verified
          ? 'GCP connected successfully!'
          : 'GCP setup complete (verification pending)');
        // Transition to idle so the connected state renders when credential prop updates
        setPhase('idle');
        onUpdate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GCP setup failed');
      setPhase('zone-select'); // Allow retry
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await deleteCredential('gcp');
      toast.success('Google Cloud disconnected');
      setPhase('idle');
      setShowDisconnectConfirm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  // Connected state
  if (credential && phase === 'idle') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between p-4 bg-success-tint border border-success/30 rounded-md">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-success-tint rounded-full flex items-center justify-center">
              <svg className="h-5 w-5 text-success-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-success-fg">Connected</p>
              <p className="text-sm text-fg-muted">
                Added: {new Date(credential.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            onClick={() => setShowDisconnectConfirm(true)}
          >
            Disconnect
          </Button>
        </div>
        {error && <Alert variant="error">{error}</Alert>}

        <ConfirmDialog
          isOpen={showDisconnectConfirm}
          onClose={() => setShowDisconnectConfirm(false)}
          onConfirm={() => void handleDisconnect()}
          title="Disconnect Google Cloud?"
          message="This will remove your GCP credentials. You will need to re-authenticate to provision nodes on Google Cloud."
          confirmLabel="Confirm Disconnect"
          variant="danger"
          loading={disconnecting}
        />
      </div>
    );
  }

  // Loading projects after OAuth redirect
  if (phase === 'loading-projects') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-sm text-fg-muted">Loading GCP projects...</span>
        </div>
      </div>
    );
  }

  // Project selection phase
  if (phase === 'project-select') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">Select a GCP project to connect:</p>
        <div>
          <label htmlFor="gcp-project-select" className="block text-xs font-medium text-fg-muted mb-1">
            GCP Project
          </label>
          <Select
            id="gcp-project-select"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
          >
            <option value="">Select a project...</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name} ({p.projectId})
              </option>
            ))}
          </Select>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex gap-3">
          <Button onClick={handleProjectSelect} disabled={!selectedProject}>
            Next
          </Button>
          <Button variant="secondary" onClick={() => { setPhase('idle'); setOauthHandle(null); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Zone selection phase
  if (phase === 'zone-select') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Select a default zone for project <strong>{selectedProject}</strong>:
        </p>
        <div>
          <label htmlFor="gcp-zone-select" className="block text-xs font-medium text-fg-muted mb-1">
            Default Zone
          </label>
          <Select
            id="gcp-zone-select"
            value={selectedZone}
            onChange={(e) => setSelectedZone(e.target.value)}
          >
            {GCP_ZONES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex gap-3">
          <Button onClick={handleSetup} disabled={loading} loading={loading}>
            Connect Google Cloud
          </Button>
          <Button variant="secondary" onClick={() => setPhase('project-select')}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  // Setting up phase
  if (phase === 'setting-up') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium text-fg-primary">Setting up GCP OIDC...</p>
        <div className="flex flex-col gap-2">
          {SETUP_STEPS.map((step) => (
            <div key={step.key} className="flex items-center gap-2 text-sm text-fg-muted">
              <div className="h-4 w-4 rounded-full border border-border animate-pulse bg-accent/20" />
              <span>{step.label}</span>
            </div>
          ))}
        </div>
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    );
  }

  // Idle / initial state
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        Connect your Google Cloud account to provision VMs on GCP Compute Engine.
        SAM uses OIDC federation — no service account keys or long-lived credentials are stored.
      </p>
      {error && <Alert variant="error">{error}</Alert>}
      <Button onClick={handleConnectClick} disabled={loading}>
        Connect Google Cloud
      </Button>
    </div>
  );
}
