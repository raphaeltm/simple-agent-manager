import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { RepoSelector } from '../components/RepoSelector';
import { BranchSelector } from '../components/BranchSelector';
import {
  createWorkspace,
  getProject,
  getProviderCatalog,
  listBranches,
  listCredentials,
  listGitHubInstallations,
  listNodes,
} from '../lib/api';
import type { CredentialProvider, GitHubInstallation, NodeResponse, ProjectDetailResponse, ProviderCatalog, VMSize } from '@simple-agent-manager/shared';
import { PROVIDER_LABELS } from '@simple-agent-manager/shared';
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
    <div className="flex items-center justify-between px-4 py-3 border-b border-border-default gap-3">

      <div className="flex items-center gap-3 min-w-0">
        <span
          aria-label={status}
          className="w-6 h-6 rounded-full flex items-center justify-center font-bold shrink-0"
          style={{
            fontSize: status === 'loading' ? 'var(--sam-type-body-size)' : 'var(--sam-type-secondary-size)',
            color: icon.color,
            backgroundColor: `color-mix(in srgb, ${icon.color} 12%, transparent)`,
          }}
        >
          {status === 'loading' ? <Spinner size="sm" /> : icon.symbol}
        </span>
        <div className="min-w-0">
          <div className="text-fg-primary font-medium" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
            {label}
          </div>
          {detail && (
            <div className="text-fg-muted mt-0.5" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
              {detail}
            </div>
          )}
        </div>
      </div>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" onClick={onAction} className="shrink-0">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

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
  const [cloudStatus, setCloudStatus] = useState<PrereqStatus>('loading');
  const [githubStatus, setGithubStatus] = useState<PrereqStatus>('loading');
  const [nodesStatus, setNodesStatus] = useState<PrereqStatus>('loading');
  const [hasCloudProvider, setHasCloudProvider] = useState(false);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [nodes, setNodes] = useState<NodeResponse[]>([]);
  const [linkedProject, setLinkedProject] = useState<ProjectDetailResponse | null>(null);

  // Provider catalog state
  const [catalogs, setCatalogs] = useState<ProviderCatalog[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const isProjectLinked = !!linkedProject;
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [repoDefaultBranch, setRepoDefaultBranch] = useState<string | undefined>(undefined);
  const [installationId, setInstallationId] = useState('');
  const [vmSize, setVmSize] = useState<VMSize>('medium');
  const [vmLocation, setVmLocation] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(locationState?.nodeId ?? '');

  // Get the active catalog based on selected provider
  const activeCatalog = catalogs.find((c) => c.provider === selectedProvider);

  // Check each prerequisite independently so status appears incrementally
  useEffect(() => {
    // Cloud provider credentials + catalog
    listCredentials()
      .then((creds) => {
        const hasCloud = creds.some((c) => c.provider === 'hetzner' || c.provider === 'scaleway');
        setHasCloudProvider(hasCloud);
        setCloudStatus(hasCloud ? 'ready' : 'missing');

        if (hasCloud) {
          // Fetch provider catalog for location/size data
          setCatalogLoading(true);
          getProviderCatalog()
            .then((resp) => {
              setCatalogs(resp.catalogs);
              const first = resp.catalogs[0];
              if (first) {
                setSelectedProvider(first.provider);
                setVmLocation(first.defaultLocation);
              }
            })
            .catch(() => {
              // Catalog fetch failed — UI will use generic fallback
            })
            .finally(() => {
              setCatalogLoading(false);
            });
        }
      })
      .catch(() => setCloudStatus('error'));

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
          setVmSize(proj.defaultVmSize as VMSize);
        }
        // Fetch branches even when project-linked so the selector has data
        void fetchBranches(proj.repository, proj.installationId, defBranch);
      })
      .catch(() => {
        // Project fetch failed — continue without project context
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const checkingPrereqs = cloudStatus === 'loading' || githubStatus === 'loading';

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

  const handleInstallationChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setInstallationId(e.target.value);
      if (!isProjectLinked) {
        setRepository('');
        setBranch('main');
        setBranches([]);
        setBranchesError(null);
        setRepoDefaultBranch(undefined);
      }
    },
    [isProjectLinked]
  );

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value;
      setSelectedProvider(provider);
      const catalog = catalogs.find((c) => c.provider === provider);
      if (catalog) {
        setVmLocation(catalog.defaultLocation);
      }
    },
    [catalogs]
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
        vmSize,
        vmLocation,
        ...(selectedProvider && !selectedNodeId ? { provider: selectedProvider as CredentialProvider } : {}),
      });

      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  const canCreate = hasCloudProvider && installations.length > 0;
  const anyMissing = cloudStatus === 'missing' || githubStatus === 'missing'
    || cloudStatus === 'error' || githubStatus === 'error';
  const showPrereqs = checkingPrereqs || anyMissing;

  const labelStyle = {
    display: 'block',
    fontSize: 'var(--sam-type-secondary-size)',
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
    marginBottom: '0.25rem',
  } as const;

  // Build VM size options from catalog or use generic fallback
  const vmSizeOptions = activeCatalog
    ? (['small', 'medium', 'large'] as VMSize[]).map((size) => {
        const sizeInfo = activeCatalog.sizes[size];
        return {
          value: size,
          label: size.charAt(0).toUpperCase() + size.slice(1),
          description: sizeInfo
            ? `${sizeInfo.vcpu} vCPUs, ${sizeInfo.ramGb}GB RAM \u2014 ${sizeInfo.price}`
            : size,
        };
      })
    : [
        { value: 'small' as VMSize, label: 'Small', description: '2-3 vCPUs, 4GB RAM' },
        { value: 'medium' as VMSize, label: 'Medium', description: '4 vCPUs, 8-12GB RAM' },
        { value: 'large' as VMSize, label: 'Large', description: '8 vCPUs, 16-32GB RAM' },
      ];

  // Build location options from catalog
  const locationOptions = activeCatalog
    ? activeCatalog.locations.map((loc) => ({
        value: loc.id,
        label: `${loc.name}, ${loc.country}`,
      }))
    : [];

  return (
    <PageLayout
      title={isProjectLinked ? `New Workspace \u2014 ${linkedProject?.name}` : 'Create Workspace'}
      onBack={() => isProjectLinked ? navigate(`/projects/${linkedProject?.id}`) : navigate('/dashboard')}
      maxWidth="md"
      headerRight={<UserMenu />}
    >
      {showPrereqs && (
        <Card className="mb-6 overflow-hidden">
          <div className="p-4 border-b border-border-default">
            <h3 className="m-0 text-fg-primary" style={{ fontSize: 'var(--sam-type-card-title-size)', fontWeight: 'var(--sam-type-card-title-weight)' as unknown as number }}>
              {checkingPrereqs ? 'Checking prerequisites...' : 'Setup Required'}
            </h3>
            {!checkingPrereqs && anyMissing && (
              <p className="text-fg-muted mt-1" style={{ margin: '4px 0 0', fontSize: 'var(--sam-type-caption-size)' }}>
                Complete the items below before creating a workspace.
              </p>
            )}
          </div>
          <PrereqItem
            label="Cloud Provider"
            status={cloudStatus}
            detail={
              cloudStatus === 'ready' ? 'Connected' :
              cloudStatus === 'missing' ? 'Required to provision VMs (Hetzner or Scaleway)' :
              cloudStatus === 'error' ? 'Failed to check credentials' : undefined
            }
            actionLabel={cloudStatus === 'missing' || cloudStatus === 'error' ? 'Settings' : undefined}
            onAction={cloudStatus === 'missing' || cloudStatus === 'error' ? () => navigate('/settings') : undefined}
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
          className="bg-surface rounded-lg border border-border-default p-6 flex flex-col gap-6"
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
                installationId={installationId}
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
              <Select id="installation" value={installationId} onChange={handleInstallationChange}>
                {installations.map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {installation.accountName} ({installation.accountType})
                  </option>
                ))}
              </Select>
            </div>
          )}

          {!selectedNodeId && catalogs.length > 1 && (
            <div>
              <label htmlFor="provider" style={labelStyle}>
                Cloud Provider
              </label>
              <Select id="provider" value={selectedProvider} onChange={handleProviderChange}>
                {catalogs.map((catalog) => (
                  <option key={catalog.provider} value={catalog.provider}>
                    {PROVIDER_LABELS[catalog.provider] ?? catalog.provider}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {!selectedNodeId && (
            <div>
              <label style={{ ...labelStyle, marginBottom: '0.5rem' }}>
                VM Size
                {activeCatalog && catalogs.length === 1 && (
                  <span className="text-fg-muted font-normal ml-1">
                    ({PROVIDER_LABELS[activeCatalog.provider] ?? activeCatalog.provider})
                  </span>
                )}
                {catalogLoading && (
                  <span className="text-fg-muted font-normal ml-2" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                    <Spinner size="sm" className="inline-block align-middle" />
                    <span className="ml-1 align-middle">Loading pricing...</span>
                  </span>
                )}
              </label>
              <div className={`grid grid-cols-3 gap-3${catalogLoading ? ' opacity-60 pointer-events-none' : ''}`}>
                {vmSizeOptions.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    aria-pressed={vmSize === size.value}
                    onClick={() => setVmSize(size.value)}
                    className={`p-3 rounded-md text-left cursor-pointer text-fg-primary transition-all duration-150 ${
                      vmSize === size.value
                        ? 'border-2 border-accent bg-accent-tint'
                        : 'border border-border-default bg-inset'
                    }`}
                  >
                    <div className="font-medium">{size.label}</div>
                    <div className="text-fg-muted mt-0.5" style={{ fontSize: 'var(--sam-type-caption-size)' }}>
                      {size.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!selectedNodeId && locationOptions.length > 0 && (
            <div>
              <label htmlFor="location" style={labelStyle}>
                Node Location
              </label>
              <Select id="location" value={vmLocation} onChange={(e) => setVmLocation(e.target.value)}>
                {locationOptions.map((loc) => (
                  <option key={loc.value} value={loc.value}>
                    {loc.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
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
