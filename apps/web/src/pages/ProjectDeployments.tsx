import { Alert, Button, EmptyState, Input, SkeletonCard } from '@simple-agent-manager/ui';
import { Plus, RefreshCw, Rocket } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { DeploymentEnvironmentSummaryCard } from '../components/deployments/DeploymentEnvironmentSummaryCard';
import { useToast } from '../hooks/useToast';
import {
  createDeploymentEnvironment,
  type DeploymentEnvironment,
  listDeploymentEnvironments,
} from '../lib/api';
import { useProjectContext } from './ProjectContext';

const DEPLOYMENT_ENVIRONMENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function ProjectDeployments() {
  const { projectId } = useProjectContext();
  const toast = useToast();

  const [environments, setEnvironments] = useState<DeploymentEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const sortedEnvironments = useMemo(
    () => [...environments].sort((a, b) => a.name.localeCompare(b.name)),
    [environments]
  );

  const loadEnvironments = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        setError(null);
        const result = await listDeploymentEnvironments(projectId);
        setEnvironments(result.environments);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load deployment environments');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    void loadEnvironments();
  }, [loadEnvironments]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setNewNameError('Enter an environment name.');
      return;
    }
    if (!DEPLOYMENT_ENVIRONMENT_NAME_RE.test(trimmed)) {
      setNewNameError(
        'Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.'
      );
      return;
    }
    setCreating(true);
    try {
      setNewNameError(null);
      const created = await createDeploymentEnvironment(projectId, trimmed);
      setEnvironments((prev) => [...prev, created]);
      setNewName('');
      toast.success('Deployment environment created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create environment');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
        <div>
          <h1 className="sam-type-page-title m-0 text-fg-primary">Deployments</h1>
          <p className="sam-type-secondary m-0 mt-1 text-fg-muted">
            Manage app environments, deployment nodes, agent policy, logs, and teardown.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void loadEnvironments(true)}
          disabled={refreshing}
        >
          <RefreshCw size={15} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </section>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="glass-surface rounded-lg p-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      >
        <label htmlFor="deployment-env-name" className="grid gap-1">
          <span className="text-sm font-medium text-fg-primary">New Environment</span>
          <Input
            id="deployment-env-name"
            value={newName}
            onChange={(event) => {
              setNewName(event.currentTarget.value.toLowerCase());
              setNewNameError(null);
            }}
            placeholder="staging"
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            aria-invalid={Boolean(newNameError)}
            aria-describedby={
              newNameError ? 'deployment-env-name-error' : 'deployment-env-name-help'
            }
          />
          {newNameError ? (
            <span id="deployment-env-name-error" className="text-xs text-danger">
              {newNameError}
            </span>
          ) : (
            <span id="deployment-env-name-help" className="text-xs text-fg-muted">
              Lowercase letters, numbers, and hyphens.
            </span>
          )}
        </label>
        <Button type="submit" loading={creating} disabled={creating || !newName.trim()}>
          <Plus size={15} />
          Create
        </Button>
      </form>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <div className="grid gap-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      ) : sortedEnvironments.length === 0 ? (
        <EmptyState
          icon={<Rocket size={44} />}
          heading="No deployment environments"
          description="Create an environment before agents can build or deploy an app for this project."
          action={{ label: 'Create staging', onClick: () => setNewName('staging') }}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
            <DeploymentEnvironmentSummaryCard key={env.id} env={env} />
          ))}
        </div>
      )}
    </div>
  );
}
