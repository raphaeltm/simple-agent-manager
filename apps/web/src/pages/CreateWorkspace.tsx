import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { RepoSelector } from '../components/RepoSelector';
import {
  createWorkspace,
  listGitHubInstallations,
  listCredentials,
} from '../lib/api';
import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { Button, Card, Input, PageLayout, Alert, Select, Spinner } from '@simple-agent-manager/ui';

const VM_SIZES = [
  { value: 'small', label: 'Small', description: '2 vCPUs, 4GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16GB RAM' },
];

const VM_LOCATIONS = [
  { value: 'nbg1', label: 'Nuremberg, DE' },
  { value: 'fsn1', label: 'Falkenstein, DE' },
  { value: 'hel1', label: 'Helsinki, FI' },
];

const IDLE_TIMEOUT_OPTIONS = [
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '1800', label: '30 minutes (default)' },
  { value: '3600', label: '1 hour' },
  { value: '7200', label: '2 hours' },
  { value: '14400', label: '4 hours' },
  { value: '28800', label: '8 hours' },
  { value: '43200', label: '12 hours' },
  { value: '86400', label: '24 hours' },
  { value: '0', label: 'Never (disabled)' },
];

export function CreateWorkspace() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingPrereqs, setCheckingPrereqs] = useState(true);
  const [hasHetzner, setHasHetzner] = useState(false);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);

  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [installationId, setInstallationId] = useState('');
  const [vmSize, setVmSize] = useState('medium');
  const [vmLocation, setVmLocation] = useState('nbg1');
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState('1800');

  useEffect(() => {
    checkPrerequisites();
  }, []);

  const checkPrerequisites = async () => {
    try {
      const [creds, installs] = await Promise.all([
        listCredentials(),
        listGitHubInstallations(),
      ]);

      setHasHetzner(creds.some((c) => c.provider === 'hetzner'));
      setInstallations(installs);

      const firstInstall = installs[0];
      if (firstInstall) {
        setInstallationId(firstInstall.id);
      }
    } catch (err) {
      console.error('Failed to check prerequisites:', err);
    } finally {
      setCheckingPrereqs(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let repo = repository;
      if (repository.startsWith('https://github.com/')) {
        repo = repository.replace('https://github.com/', '').replace(/\.git$/, '');
      }

      const workspace = await createWorkspace({
        name,
        repository: repo,
        branch,
        installationId,
        vmSize: vmSize as any,
        vmLocation: vmLocation as any,
        idleTimeoutSeconds: parseInt(idleTimeoutSeconds, 10),
      });

      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  if (checkingPrereqs) {
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: 'var(--sam-color-bg-canvas)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Spinner size="lg" />
      </div>
    );
  }

  const canCreate = hasHetzner && installations.length > 0;

  const labelStyle = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
    marginBottom: '0.25rem',
  } as const;

  return (
    <PageLayout
      title="Create Workspace"
      onBack={() => navigate('/dashboard')}
      maxWidth="md"
      headerRight={<UserMenu />}
    >
      {!canCreate ? (
        <Card style={{ padding: 'var(--sam-space-6)' }}>
          <div style={{ textAlign: 'center', padding: 'var(--sam-space-8) 0' }}>
            <svg style={{ margin: '0 auto', height: 48, width: 48, color: 'var(--sam-color-fg-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>
              Setup Required
            </h3>
            <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
              Before creating a workspace, please complete the following:
            </p>
            <ul style={{ marginTop: 'var(--sam-space-4)', textAlign: 'left', maxWidth: '20rem', margin: 'var(--sam-space-4) auto 0', display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-2)', listStyle: 'none', padding: 0 }}>
              <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: hasHetzner ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}>
                <svg style={{ height: 20, width: 20, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={hasHetzner ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'} />
                </svg>
                <span>Connect Hetzner Cloud account</span>
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: installations.length > 0 ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}>
                <svg style={{ height: 20, width: 20, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={installations.length > 0 ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'} />
                </svg>
                <span>Install GitHub App</span>
              </li>
            </ul>
            <div style={{ marginTop: 'var(--sam-space-6)' }}>
              <Button onClick={() => navigate('/settings')} size="lg">
                Go to Settings
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 'var(--sam-radius-lg)',
            border: '1px solid var(--sam-color-border-default)',
            padding: 'var(--sam-space-6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sam-space-6)',
          }}
        >
          {error && (
            <Alert variant="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          <div>
            <label htmlFor="name" style={labelStyle}>Workspace Name</label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              required
              maxLength={64}
            />
          </div>

          <div>
            <label htmlFor="repository" style={labelStyle}>Repository</label>
            <RepoSelector
              id="repository"
              value={repository}
              onChange={setRepository}
              required
            />
          </div>

          <div>
            <label htmlFor="branch" style={labelStyle}>Branch</label>
            <Input
              id="branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </div>

          {installations.length > 1 && (
            <div>
              <label htmlFor="installation" style={labelStyle}>GitHub Account</label>
              <Select
                id="installation"
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
              >
                {installations.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.accountName} ({inst.accountType})
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div>
            <label style={{ ...labelStyle, marginBottom: '0.5rem' }}>VM Size</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sam-space-3)' }}>
              {VM_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  onClick={() => setVmSize(size.value)}
                  style={{
                    padding: 'var(--sam-space-3)',
                    border: vmSize === size.value
                      ? '2px solid var(--sam-color-accent-primary)'
                      : '1px solid var(--sam-color-border-default)',
                    borderRadius: 'var(--sam-radius-md)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    backgroundColor: vmSize === size.value
                      ? 'rgba(22, 163, 74, 0.1)'
                      : 'var(--sam-color-bg-inset)',
                    color: 'var(--sam-color-fg-primary)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{size.label}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginTop: '0.125rem' }}>{size.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="location" style={labelStyle}>Location</label>
            <Select
              id="location"
              value={vmLocation}
              onChange={(e) => setVmLocation(e.target.value)}
            >
              {VM_LOCATIONS.map((loc) => (
                <option key={loc.value} value={loc.value}>
                  {loc.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="idleTimeout" style={labelStyle}>Idle Timeout</label>
            <Select
              id="idleTimeout"
              value={idleTimeoutSeconds}
              onChange={(e) => setIdleTimeoutSeconds(e.target.value)}
            >
              {IDLE_TIMEOUT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <p style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginTop: '0.25rem' }}>
              Workspace will automatically shut down after this period of inactivity
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sam-space-3)', paddingTop: 'var(--sam-space-4)' }}>
            <Button
              type="button"
              onClick={() => navigate('/dashboard')}
              variant="secondary"
              size="md"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading || !name || !repository}
              size="lg"
              loading={loading}
            >
              Create Workspace
            </Button>
          </div>
        </form>
      )}
    </PageLayout>
  );
}
