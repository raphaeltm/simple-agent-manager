import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { RepoSelector } from '../components/RepoSelector';
import {
  createWorkspace,
  listCredentials,
  listGitHubInstallations,
  listNodes,
} from '../lib/api';
import type { GitHubInstallation, NodeResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Input, PageLayout, Select, Spinner } from '@simple-agent-manager/ui';

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

type LocationState = {
  nodeId?: string;
};

export function CreateWorkspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as LocationState | null) ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingPrereqs, setCheckingPrereqs] = useState(true);
  const [hasHetzner, setHasHetzner] = useState(false);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [nodes, setNodes] = useState<NodeResponse[]>([]);

  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [installationId, setInstallationId] = useState('');
  const [vmSize, setVmSize] = useState('medium');
  const [vmLocation, setVmLocation] = useState('nbg1');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(locationState?.nodeId ?? '');

  useEffect(() => {
    void checkPrerequisites();
  }, []);

  const checkPrerequisites = async () => {
    try {
      const [creds, installs, nodeRows] = await Promise.all([
        listCredentials(),
        listGitHubInstallations(),
        listNodes(),
      ]);

      setHasHetzner(creds.some((credential) => credential.provider === 'hetzner'));
      setInstallations(installs);
      setNodes(nodeRows.filter((node) => node.status !== 'error'));

      const firstInstallation = installs[0];
      if (firstInstallation) {
        setInstallationId(firstInstallation.id);
      }

      if (locationState?.nodeId && nodeRows.some((node) => node.id === locationState.nodeId)) {
        setSelectedNodeId(locationState.nodeId);
      }
    } catch (err) {
      console.error('Failed to check prerequisites:', err);
      setError(err instanceof Error ? err.message : 'Failed to load prerequisites');
    } finally {
      setCheckingPrereqs(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      let repo = repository;
      if (repository.startsWith('https://github.com/')) {
        repo = repository.replace('https://github.com/', '').replace(/\.git$/, '');
      }

      const workspace = await createWorkspace({
        name,
        nodeId: selectedNodeId || undefined,
        repository: repo,
        branch,
        installationId,
        vmSize: vmSize as any,
        vmLocation: vmLocation as any,
        idleTimeoutSeconds: 0,
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
      <div
        style={{
          minHeight: 'var(--sam-app-height)',
          backgroundColor: 'var(--sam-color-bg-canvas)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
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
            <h3
              style={{
                marginTop: 'var(--sam-space-4)',
                fontSize: '1.125rem',
                fontWeight: 500,
                color: 'var(--sam-color-fg-primary)',
              }}
            >
              Setup Required
            </h3>
            <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
              Before creating a workspace, connect Hetzner and install the GitHub App.
            </p>
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
            <label htmlFor="name" style={labelStyle}>
              Workspace Name
            </label>
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
            <label htmlFor="repository" style={labelStyle}>
              Repository
            </label>
            <RepoSelector id="repository" value={repository} onChange={setRepository} required />
          </div>

          <div>
            <label htmlFor="branch" style={labelStyle}>
              Branch
            </label>
            <Input
              id="branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </div>

          <div>
            <label htmlFor="node" style={labelStyle}>
              Node
            </label>
            <Select
              id="node"
              value={selectedNodeId}
              onChange={(e) => setSelectedNodeId(e.target.value)}
            >
              <option value="">Create a new node automatically</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name} ({node.status})
                </option>
              ))}
            </Select>
          </div>

          {installations.length > 1 && (
            <div>
              <label htmlFor="installation" style={labelStyle}>
                GitHub Account
              </label>
              <Select id="installation" value={installationId} onChange={(e) => setInstallationId(e.target.value)}>
                {installations.map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {installation.accountName} ({installation.accountType})
                  </option>
                ))}
              </Select>
            </div>
          )}

          {!selectedNodeId && (
            <>
              <div>
                <label style={{ ...labelStyle, marginBottom: '0.5rem' }}>Node Size</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sam-space-3)' }}>
                  {VM_SIZES.map((size) => (
                    <button
                      key={size.value}
                      type="button"
                      onClick={() => setVmSize(size.value)}
                      style={{
                        padding: 'var(--sam-space-3)',
                        border:
                          vmSize === size.value
                            ? '2px solid var(--sam-color-accent-primary)'
                            : '1px solid var(--sam-color-border-default)',
                        borderRadius: 'var(--sam-radius-md)',
                        textAlign: 'left',
                        cursor: 'pointer',
                        backgroundColor:
                          vmSize === size.value
                            ? 'rgba(22, 163, 74, 0.1)'
                            : 'var(--sam-color-bg-inset)',
                        color: 'var(--sam-color-fg-primary)',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{size.label}</div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--sam-color-fg-muted)',
                          marginTop: '0.125rem',
                        }}
                      >
                        {size.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="location" style={labelStyle}>
                  Node Location
                </label>
                <Select id="location" value={vmLocation} onChange={(e) => setVmLocation(e.target.value)}>
                  {VM_LOCATIONS.map((locationOption) => (
                    <option key={locationOption.value} value={locationOption.value}>
                      {locationOption.label}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--sam-space-3)',
              paddingTop: 'var(--sam-space-4)',
            }}
          >
            <Button type="button" onClick={() => navigate('/dashboard')} variant="secondary" size="md">
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !name || !repository} size="lg" loading={loading}>
              Create Workspace
            </Button>
          </div>
        </form>
      )}
    </PageLayout>
  );
}
