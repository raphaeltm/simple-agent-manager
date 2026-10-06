import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Select, Spinner } from '@simple-agent-manager/ui';
import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import type { GcpProject } from '../lib/api';
import {
  API_URL,
  deleteCredential,
  getGcpOAuthResult,
  listGcpProjects,
  runGcpSetup,
  saveGcpServiceAccountCredential,
} from '../lib/api';
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
  { key: 'grant_project_roles', label: 'Granting compute access' },
];

const SERVICE_ACCOUNT_COMMANDS = `PROJECT_ID="your-gcp-project-id"
SERVICE_ACCOUNT="sam-vm-manager@\${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable compute.googleapis.com --project="\${PROJECT_ID}"
gcloud iam service-accounts create sam-vm-manager --project="\${PROJECT_ID}" --display-name="SAM VM manager"
gcloud projects add-iam-policy-binding "\${PROJECT_ID}" --member="serviceAccount:\${SERVICE_ACCOUNT}" --role="roles/compute.instanceAdmin.v1"
gcloud projects add-iam-policy-binding "\${PROJECT_ID}" --member="serviceAccount:\${SERVICE_ACCOUNT}" --role="roles/compute.securityAdmin"
gcloud iam service-accounts keys create sam-service-account.json --iam-account="\${SERVICE_ACCOUNT}" --project="\${PROJECT_ID}"`;

interface GcpCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

type SetupPhase =
  | 'idle'
  | 'loading-projects'
  | 'project-select'
  | 'zone-select'
  | 'setting-up'
  | 'service-account';

export function GcpCredentialForm({ credential, onUpdate }: GcpCredentialFormProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [oauthHandle, setOauthHandle] = useState<string | null>(null);
  const [projects, setProjects] = useState<GcpProject[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedZone, setSelectedZone] = useState('us-central1-a');
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setupFlag = params.get('gcp_setup');
    const gcpError = params.get('gcp_error');

    if (setupFlag) {
      setPhase('loading-projects');
      const url = new URL(window.location.href);
      url.searchParams.delete('gcp_setup');
      window.history.replaceState({}, '', url.toString());
      void getGcpOAuthResult()
        .then((result) => setOauthHandle(result.handle))
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
      fetchProjects().catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load GCP projects');
        setPhase('idle');
      });
    }
  }, [phase, oauthHandle, fetchProjects]);

  const handleConnectWif = () => {
    window.location.href = `${API_URL}/auth/google/authorize`;
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
          ? 'GCP connected with Workload Identity Federation'
          : 'GCP setup complete (verification pending)');
        setPhase('idle');
        onUpdate();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GCP setup failed');
      setPhase('zone-select');
    } finally {
      setLoading(false);
    }
  };

  const persistServiceAccount = async () => {
    setLoading(true);
    setError(null);
    try {
      await saveGcpServiceAccountCredential({
        serviceAccountJson,
        defaultZone: selectedZone,
      });
      setServiceAccountJson('');
      setShowRotateConfirm(false);
      setPhase('idle');
      toast.success(credential ? 'GCP service-account credential rotated' : 'GCP service account connected');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Service-account validation failed');
      setShowRotateConfirm(false);
    } finally {
      setLoading(false);
    }
  };

  const requestServiceAccountSave = () => {
    if (!serviceAccountJson.trim()) {
      setError('Paste or choose a service-account JSON file');
      return;
    }
    if (credential) {
      setShowRotateConfirm(true);
    } else {
      void persistServiceAccount();
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      setServiceAccountJson(await file.text());
    } catch {
      setError('Could not read the selected JSON file');
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

  const copyCommands = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable');
      }
      await navigator.clipboard.writeText(SERVICE_ACCOUNT_COMMANDS);
      toast.success('gcloud commands copied');
    } catch {
      toast.error('Could not copy gcloud commands');
    }
  };

  if (credential && phase === 'idle') {
    const metadata = credential.gcp;
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-success/30 bg-success-tint p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-success-fg">Connected</p>
              <p className="mt-1 text-sm text-fg-muted">
                {metadata?.authType === 'service-account-key'
                  ? 'Service account JSON (long-lived key)'
                  : 'Workload Identity Federation (recommended)'}
              </p>
              {metadata && (
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-xs text-fg-muted">GCP project</dt>
                    <dd className="break-all text-fg-primary">{metadata.gcpProjectId}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-fg-muted">Default zone</dt>
                    <dd className="break-all text-fg-primary">{metadata.defaultZone}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-xs text-fg-muted">Service account</dt>
                    <dd className="break-all text-fg-primary">{metadata.serviceAccountEmail}</dd>
                  </div>
                  {metadata.privateKeyId && (
                    <div className="min-w-0 sm:col-span-2">
                      <dt className="text-xs text-fg-muted">Private key ID</dt>
                      <dd className="break-all font-mono text-xs text-fg-primary">{metadata.privateKeyId}</dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
            <div className="flex flex-col gap-2 sm:shrink-0">
              {metadata?.authType === 'service-account-key' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedZone(metadata.defaultZone);
                    setPhase('service-account');
                  }}
                >
                  Rotate JSON key
                </Button>
              )}
              <Button variant="danger" size="sm" onClick={() => setShowDisconnectConfirm(true)}>
                Disconnect
              </Button>
            </div>
          </div>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        <ConfirmDialog
          isOpen={showDisconnectConfirm}
          onClose={() => setShowDisconnectConfirm(false)}
          onConfirm={() => void handleDisconnect()}
          title="Disconnect Google Cloud?"
          message="SAM will delete its encrypted credential copies and cached access tokens. It will not delete or revoke a service-account key in Google Cloud."
          confirmLabel="Disconnect"
          variant="danger"
          loading={disconnecting}
        />
      </div>
    );
  }

  if (phase === 'service-account') {
    return (
      <div className="flex flex-col gap-4" data-testid="gcp-service-account-form">
        <Alert variant="warning">
          Google recommends Workload Identity Federation whenever possible. A JSON key is a long-lived bearer credential, and some organizations disable key creation by policy.
        </Alert>
        <div>
          <h3 className="text-sm font-semibold text-fg-primary">Service account JSON</h3>
          <p className="mt-1 text-sm text-fg-muted">
            SAM verifies the key and Compute access before replacing your current connection. The private key is encrypted and is never shown again.
          </p>
        </div>
        <label className="block space-y-1.5 text-sm font-medium text-fg-primary">
          Choose JSON file
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => void handleFile(event)}
            className="block min-h-11 w-full rounded-sm border border-border-default bg-inset px-3 py-2 text-sm"
          />
        </label>
        <label className="block space-y-1.5 text-sm font-medium text-fg-primary">
          Or paste JSON
          <textarea
            value={serviceAccountJson}
            onChange={(event) => setServiceAccountJson(event.target.value)}
            placeholder="Paste the complete service-account JSON"
            className="min-h-40 w-full resize-y rounded-sm border border-border-default bg-inset px-3 py-2 font-mono text-xs text-fg-primary placeholder:text-fg-muted"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label htmlFor="gcp-service-account-zone" className="block space-y-1.5 text-sm font-medium text-fg-primary">
          Default zone
          <Select
            id="gcp-service-account-zone"
            value={selectedZone}
            onChange={(event) => setSelectedZone(event.target.value)}
          >
            {GCP_ZONES.map((zone) => (
              <option key={zone.id} value={zone.id}>{zone.label}</option>
            ))}
          </Select>
        </label>
        <details className="rounded-md border border-border-default bg-surface-secondary p-3">
          <summary className="cursor-pointer text-sm font-medium text-fg-primary">
            Least-privilege gcloud setup commands
          </summary>
          <p className="mt-2 text-xs text-fg-muted">
            VM provisioning needs Compute Instance Admin and Compute Security Admin. Vertex AI access is optional and is not included here. Project Owner is not required.
          </p>
          <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-3 text-xs text-fg-primary">{SERVICE_ACCOUNT_COMMANDS}</pre>
          <Button variant="secondary" size="sm" onClick={() => void copyCommands()}>
            Copy commands
          </Button>
        </details>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={requestServiceAccountSave} loading={loading} disabled={loading}>
            {credential ? 'Validate and rotate key' : 'Validate and connect'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => { setPhase('idle'); setServiceAccountJson(''); setError(null); }}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
        <ConfirmDialog
          isOpen={showRotateConfirm}
          onClose={() => setShowRotateConfirm(false)}
          onConfirm={() => void persistServiceAccount()}
          title="Rotate GCP service-account key?"
          message="SAM will verify the new key before atomically replacing its encrypted copies. This does not disable the old key in Google Cloud; revoke it there after rotation succeeds."
          confirmLabel="Validate and rotate"
          variant="warning"
          loading={loading}
        />
      </div>
    );
  }

  if (phase === 'loading-projects') {
    return <div className="flex items-center gap-2"><Spinner size="sm" /><span className="text-sm text-fg-muted">Loading GCP projects...</span></div>;
  }

  if (phase === 'project-select') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">Select a GCP project to connect:</p>
        <label htmlFor="gcp-project-select" className="block text-xs font-medium text-fg-muted">
          GCP Project
          <Select id="gcp-project-select" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
            <option value="">Select a project...</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>{project.name} ({project.projectId})</option>
            ))}
          </Select>
        </label>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex gap-3">
          <Button onClick={() => selectedProject && setPhase('zone-select')} disabled={!selectedProject}>Next</Button>
          <Button variant="secondary" onClick={() => { setPhase('idle'); setOauthHandle(null); }}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (phase === 'zone-select') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">Select a default zone for project <strong>{selectedProject}</strong>:</p>
        <label htmlFor="gcp-zone-select" className="block text-xs font-medium text-fg-muted">
          Default Zone
          <Select id="gcp-zone-select" value={selectedZone} onChange={(event) => setSelectedZone(event.target.value)}>
            {GCP_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
          </Select>
        </label>
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex gap-3">
          <Button onClick={() => void handleSetup()} disabled={loading} loading={loading}>Connect with WIF</Button>
          <Button variant="secondary" onClick={() => setPhase('project-select')}>Back</Button>
        </div>
      </div>
    );
  }

  if (phase === 'setting-up') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium text-fg-primary">Setting up GCP Workload Identity Federation...</p>
        <div className="flex flex-col gap-2">
          {SETUP_STEPS.map((step) => (
            <div key={step.key} className="flex items-center gap-2 text-sm text-fg-muted">
              <div className="h-4 w-4 animate-pulse rounded-full border border-border bg-accent/20" />
              <span>{step.label}</span>
            </div>
          ))}
        </div>
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-md border border-accent/40 bg-accent-tint p-4">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-fg-primary">Workload Identity Federation</h3>
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-fg-on-accent">Recommended</span>
          </div>
          <p className="mt-2 text-sm text-fg-muted">
            Keyless, short-lived authentication. A platform admin must configure the separate Google infrastructure OAuth client.
          </p>
          <Button className="mt-4" onClick={handleConnectWif} disabled={loading}>Connect with Google</Button>
        </section>
        <section className="rounded-md border border-border-default bg-surface p-4">
          <h3 className="font-semibold text-fg-primary">Service account JSON</h3>
          <p className="mt-2 text-sm text-fg-muted">
            OAuth-free setup for self-hosters. Stores an encrypted long-lived key and requires manual key rotation in Google Cloud.
          </p>
          <Button className="mt-4" variant="secondary" onClick={() => setPhase('service-account')}>
            Use service account JSON
          </Button>
        </section>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
