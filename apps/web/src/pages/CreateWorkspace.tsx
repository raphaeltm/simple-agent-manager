import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { RepoSelector } from '../components/RepoSelector';
import { BranchSelector } from '../components/BranchSelector';
import {
  createWorkspace,
  getProject,
  listBranches,
  listCredentials,
  listGitHubInstallations,
  listNodes,
} from '../lib/api';
import type { GitHubInstallation, NodeResponse, ProjectDetailResponse, VMSize, VMLocation } from '@simple-agent-manager/shared';
import { Alert, Button, Card, Input, PageLayout, Select, Spinner } from '@simple-agent-manager/ui';

type PrereqStatus = 'loading' | 'ready' | 'missing' | 'error';

interface PrereqItemProps {
  label: string;
  status: PrereqStatus;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function PrereqItem({ label, status, detail, actionLabel, onAction }: PrereqItemProps) {
  const iconMap: Record<PrereqStatus, { symbol: string; color: string }> = {
    loading: { symbol: '\u2026', color: 'var(--sam-color-fg-muted)' },
    ready: { symbol: '\u2713', color: 'var(--sam-color-success)' },
    missing: { symbol: '\u2717', color: 'var(--sam-color-danger)' },
    error: { symbol: '!', color: 'var(--sam-color-warning)' },
  };
  const icon = iconMap[status];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--sam-space-3) var(--sam-space-4)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        gap: 'var(--sam-space-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)', minWidth: 0 }}>
        <span
          aria-label={status}
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: status === 'loading' ? 'var(--sam-type-body-size)' : 'var(--sam-type-secondary-size)',
            fontWeight: 700,
            color: icon.color,
            backgroundColor: `color-mix(in srgb, ${icon.color} 12%, transparent)`,
            flexShrink: 0,
          }}
        >
          {status === 'loading' ? <Spinner size="sm" /> : icon.symbol}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--sam-type-secondary-size)', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>
            {label}
          </div>
          {detail && (
            <div style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', marginTop: 2 }}>
              {detail}
            </div>
          )}
        </div>
      </div>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" onClick={onAction} style={{ flexShrink: 0 }}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

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
  projectId?: string;
};

export function CreateWorkspace() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as LocationState | null) ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hetznerStatus, setHetznerStatus] = useState<PrereqStatus>('loading');
  const [githubStatus, setGithubStatus] = useState<PrereqStatus>('loading');
  const [nodesStatus, setNodesStatus] = useState<PrereqStatus>('loading');
  const [hasHetzner, setHasHetzner] = useState(false);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [nodes, setNodes] = useState<NodeResponse[]>([]);
  const [linkedProject, setLinkedProject] = useState<ProjectDetailResponse | null>(null);

  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const isProjectLinked = !!linkedProject;
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | undefined>(undefined);
  const [installationId, setInstallationId] = useState('');
  const [vmSize, setVmSize] = useState('medium');
  const [vmLocation, setVmLocation] = useState('nbg1');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(locationState?.nodeId ?? '');

  // Check each prerequisite independently so status appears incrementally
  useEffect(() => {
    // Hetzner credentials
    listCredentials()
      .then((creds) => {
        const found = creds.some((c) => c.provider === 'hetzner');
        setHasHetzner(found);
        setHetznerStatus(found ? 'ready' : 'missing');
      })
      .catch(() => setHetznerStatus('error'));

    // GitHub App installations
    listGitHubInstallations()
      .then((installs) => {
        setInstallations(installs);
        setGithubStatus(installs.length > 0 ? 'ready' : 'missing');
        const first = installs[0];
        if (first) setInstallationId(first.id);
      })
      .catch(() => setGithubStatus('error'));

    // Available nodes
    listNodes()
      .then((nodeRows) => {
        const usable = nodeRows.filter((n) => n.status !== 'error');
        setNodes(usable);
        setNodesStatus('ready');
        if (locationState?.nodeId && usable.some((n) => n.id === locationState.nodeId)) {
          setSelectedNodeId(locationState.nodeId);
        }
      })
      .catch(() => setNodesStatus('error'));
  }, []);

  // Load project context if navigated from a project
  useEffect(() => {
    const projectId = locationState?.projectId;
    if (!projectId) return;

    getProject(projectId)
      .then((proj) => {
        setLinkedProject(proj);
        setName(`${proj.name} Workspace`);
        setRepository(proj.repository);
        const defBranch = proj.defaultBranch ?? 'main';
        setBranch(defBranch);
        setRepoDefaultBranch(defBranch);
        setInstallationId(proj.installationId);
        if (proj.defaultVmSize) {
          setVmSize(proj.defaultVmSize);
        }
        // Fetch branches even when project-linked so the selector has data
        void fetchBranches(proj.repository, proj.installationId, defBranch);
      })
      .catch(() => {
        // Project fetch failed — continue without project context
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const checkingPrereqs = hetznerStatus === 'loading' || githubStatus === 'loading';

  const fetchBranches = useCallback(async (fullName: string, instId: string, defBranch?: string) => {
    setBranchesLoading(true);
    setBranches([]);
    setBranchesError(null);
    try {
      const result = await listBranches(fullName, instId || undefined, defBranch);
      setBranches(result);

      // If no branches returned (shouldn't happen), add common defaults
      if (result.length === 0) {
        setBranches([{ name: 'main' }, { name: 'master' }]);
        setBranchesError('Could not fetch branches, showing common defaults');
      }
    } catch (err) {
      console.log('Could not fetch branches:', err);
      // Provide common branch names as fallback
      setBranches([{ name: 'main' }, { name: 'master' }, { name: 'develop' }]);
      setBranchesError('Unable to fetch branches. Common branch names provided.');
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  const handleRepoSelect = useCallback(
    (repo: { fullName: string; defaultBranch: string } | null) => {
      if (repo) {
        setBranch(repo.defaultBranch);
        setRepoDefaultBranch(repo.defaultBranch);
        void fetchBranches(repo.fullName, installationId, repo.defaultBranch);
      } else {
        setBranches([]);
        setRepoDefaultBranch(undefined);
      }
    },
    [fetchBranches, installationId]
  );

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
        projectId: linkedProject?.id,
        nodeId: selectedNodeId || undefined,
        repository: repo,
        branch,
        installationId,
        vmSize: vmSize as VMSize,
        vmLocation: vmLocation as VMLocation,
      });

      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  const canCreate = hasHetzner && installations.length > 0;
  const anyMissing = hetznerStatus === 'missing' || githubStatus === 'missing'
    || hetznerStatus === 'error' || githubStatus === 'error';
  const showPrereqs = checkingPrereqs || anyMissing;

  const labelStyle = {
    display: 'block',
    fontSize: 'var(--sam-type-secondary-size)',
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
    marginBottom: '0.25rem',
  } as const;

  return (
    <PageLayout
      title={isProjectLinked ? `New Workspace — ${linkedProject?.name}` : 'Create Workspace'}
      onBack={() => isProjectLinked ? navigate(`/projects/${linkedProject?.id}`) : navigate('/dashboard')}
      maxWidth="md"
      headerRight={<UserMenu />}
    >
      {showPrereqs && (
        <Card style={{ marginBottom: 'var(--sam-space-6)', overflow: 'hidden' }}>
          <div style={{ padding: 'var(--sam-space-4)', borderBottom: '1px solid var(--sam-color-border-default)' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--sam-type-card-title-size)', fontWeight: 'var(--sam-type-card-title-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>
              {checkingPrereqs ? 'Checking prerequisites...' : 'Setup Required'}
            </h3>
            {!checkingPrereqs && anyMissing && (
              <p style={{ margin: '4px 0 0', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                Complete the items below before creating a workspace.
              </p>
            )}
          </div>
          <PrereqItem
            label="Hetzner Cloud Token"
            status={hetznerStatus}
            detail={
              hetznerStatus === 'ready' ? 'Connected' :
              hetznerStatus === 'missing' ? 'Required to provision VMs' :
              hetznerStatus === 'error' ? 'Failed to check credentials' : undefined
            }
            actionLabel={hetznerStatus === 'missing' || hetznerStatus === 'error' ? 'Settings' : undefined}
            onAction={hetznerStatus === 'missing' || hetznerStatus === 'error' ? () => navigate('/settings') : undefined}
          />
          <PrereqItem
            label="GitHub App Installation"
            status={githubStatus}
            detail={
              githubStatus === 'ready' ? `${installations.length} installation${installations.length > 1 ? 's' : ''} found` :
              githubStatus === 'missing' ? 'Required to access repositories' :
              githubStatus === 'error' ? 'Failed to check installations' : undefined
            }
            actionLabel={githubStatus === 'missing' || githubStatus === 'error' ? 'Settings' : undefined}
            onAction={githubStatus === 'missing' || githubStatus === 'error' ? () => navigate('/settings') : undefined}
          />
          <PrereqItem
            label="Nodes"
            status={nodesStatus}
            detail={
              nodesStatus === 'ready'
                ? nodes.length > 0
                  ? `${nodes.length} available node${nodes.length > 1 ? 's' : ''}`
                  : 'None yet \u2014 one will be created automatically'
                : nodesStatus === 'error' ? 'Failed to load nodes' : undefined
            }
          />
        </Card>
      )}

      {canCreate && (
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

          {isProjectLinked && (
            <div style={{
              padding: 'var(--sam-space-3) var(--sam-space-4)',
              borderRadius: 'var(--sam-radius-md)',
              backgroundColor: 'color-mix(in srgb, var(--sam-color-accent-primary) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--sam-color-accent-primary) 25%, transparent)',
              fontSize: 'var(--sam-type-caption-size)',
              color: 'var(--sam-color-fg-muted)',
            }}>
              Creating workspace for project <strong style={{ color: 'var(--sam-color-fg-primary)' }}>{linkedProject?.name}</strong>.
              Repository and branch are pre-filled from the project.
            </div>
          )}

          <div>
            <label htmlFor="repository" style={labelStyle}>
              Repository
            </label>
            {isProjectLinked ? (
              <Input
                id="repository"
                type="text"
                value={repository}
                readOnly
                style={{ opacity: 0.7, cursor: 'not-allowed' }}
              />
            ) : (
              <RepoSelector
                id="repository"
                value={repository}
                onChange={setRepository}
                onRepoSelect={handleRepoSelect}
                required
              />
            )}
          </div>

          <div>
            <label htmlFor="branch" style={labelStyle}>
              Branch
            </label>
            <BranchSelector
              id="branch"
              branches={branches}
              value={branch}
              onChange={setBranch}
              defaultBranch={repoDefaultBranch}
              loading={branchesLoading}
              error={branchesError}
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

          <div>
            <label style={{ ...labelStyle, marginBottom: '0.5rem' }}>VM Size</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sam-space-3)' }}>
              {VM_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  aria-pressed={vmSize === size.value}
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
                        ? 'var(--sam-color-accent-primary-tint)'
                        : 'var(--sam-color-bg-inset)',
                    color: 'var(--sam-color-fg-primary)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{size.label}</div>
                  <div
                    style={{
                      fontSize: 'var(--sam-type-caption-size)',
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

          {!selectedNodeId && (
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
