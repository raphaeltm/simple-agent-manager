import type {
  CapacityPoolScope,
  DefaultCapacityPoolSummary,
  DefaultCapacityPoolUpdateRequest,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import {
  fetchInstallationDefaultCapacityPools,
  fetchProjectDefaultCapacityPools,
  fetchUserDefaultCapacityPools,
  reconcileInstallationDefaultCapacityPools,
  reconcileProjectDefaultCapacityPools,
  reconcileUserDefaultCapacityPools,
  updateInstallationDefaultCapacityPools,
  updateProjectDefaultCapacityPools,
  updateUserDefaultCapacityPools,
} from '../../lib/api/capacity-pools';
import { POOL_SCOPE_COPY } from '../../lib/compute-pool-copy';
import { buildMachineGroups } from '../../lib/compute-pool-machines';
import { capacityPoolQueryKeys } from '../../lib/query-options/capacity-pools';
import { ComputePoolEditor } from '../compute-pool/ComputePoolEditor';
import { ComputePoolEmptyState } from '../compute-pool/ComputePoolEmptyState';
import { ComputePoolOverview } from '../compute-pool/ComputePoolOverview';

const TEXT_LINK = 'text-accent underline-offset-2 hover:underline';

type DefaultCapacityPoolsPanelProps =
  | { scope?: 'project'; projectId: string }
  | { scope: 'user'; projectId?: never }
  | { scope: 'installation'; projectId?: never };

/** Explains that the page shows a pool this scope does not own and cannot edit. */
function FallbackNotice({
  fallbackScope,
  projectId,
}: {
  fallbackScope: CapacityPoolScope;
  projectId: string | null;
}) {
  const ownPool =
    fallbackScope === 'installation' ? (
      <Link to="/admin/infrastructure" className={TEXT_LINK}>
        Edit the shared pool
      </Link>
    ) : (
      <Link to="/settings/infrastructure" className={TEXT_LINK}>
        Edit your pool
      </Link>
    );
  return (
    <div className="grid gap-1 rounded-md border border-border-default bg-inset px-3 py-2 text-sm">
      <p className="m-0 text-fg-primary">
        This project uses{' '}
        {fallbackScope === 'installation'
          ? 'the shared compute pool'
          : 'your personal compute pool'}
        . {ownPool}
      </p>
      {projectId && (
        <p className="m-0 text-xs text-fg-muted">
          To give this project machines of its own,{' '}
          <Link to={`/projects/${projectId}/settings/connections`} className={TEXT_LINK}>
            connect a cloud account to the project
          </Link>
          .
        </p>
      )}
    </div>
  );
}

export function DefaultCapacityPoolsPanel(props: DefaultCapacityPoolsPanelProps) {
  const headingId = useId();
  const queryScope = useQueryScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const scope = props.scope ?? 'project';
  const projectId = scope === 'project' ? (props.projectId ?? null) : null;
  const copy = POOL_SCOPE_COPY[scope];
  const providerCatalog = useProviderCatalog(queryScope, {
    scope,
    projectId: scope === 'project' ? projectId : null,
  });
  const queryKey =
    scope === 'project'
      ? capacityPoolQueryKeys.projectDefaults(queryScope, projectId ?? '')
      : scope === 'user'
        ? capacityPoolQueryKeys.userDefaults(queryScope)
        : capacityPoolQueryKeys.installationDefaults(queryScope);
  const query = useQuery<ProjectDefaultCapacityPoolsResponse>({
    queryKey,
    queryFn: () =>
      scope === 'project'
        ? fetchProjectDefaultCapacityPools(projectId ?? '')
        : scope === 'user'
          ? fetchUserDefaultCapacityPools()
          : fetchInstallationDefaultCapacityPools(),
    enabled: Boolean(queryScope),
  });
  const [isEditing, setIsEditing] = useState(false);

  const ownedDefault =
    query.data?.defaults.find((item) => item.scope === scope && item.visibility === 'visible')
      ?.summary ?? null;
  const effective = query.data?.effective ?? null;
  // A scope that owns a pool always shows it, even when it allows no machines yet, so it
  // stays editable. Otherwise show the pool this scope falls back to, read-only.
  const shown: DefaultCapacityPoolSummary | null = ownedDefault ?? effective;
  const fallbackScope = !ownedDefault && effective ? effective.pool.scope : null;
  const canEdit = Boolean(query.data?.policyMutationSupported && ownedDefault);
  const catalogs = providerCatalog.catalogs;
  const groups = useMemo(
    () => (shown ? buildMachineGroups(shown.candidates, catalogs, shown.sources) : []),
    [shown, catalogs]
  );

  const reconcileMutation = useMutation({
    mutationFn: () =>
      scope === 'project'
        ? reconcileProjectDefaultCapacityPools(projectId ?? '')
        : scope === 'user'
          ? reconcileUserDefaultCapacityPools()
          : reconcileInstallationDefaultCapacityPools(),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.success('Machine list refreshed');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to refresh the machine list');
    },
  });
  const updateMutation = useMutation({
    mutationFn: (body: DefaultCapacityPoolUpdateRequest) =>
      scope === 'project'
        ? updateProjectDefaultCapacityPools(projectId ?? '', body)
        : scope === 'user'
          ? updateUserDefaultCapacityPools(body)
          : updateInstallationDefaultCapacityPools(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setIsEditing(false);
      toast.success('Compute pool saved');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save the compute pool');
    },
  });

  const busy = reconcileMutation.isPending || updateMutation.isPending;

  return (
    <section
      className="glass-surface grid min-w-0 gap-4 rounded-lg p-4"
      aria-labelledby={headingId}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="sam-type-section-heading m-0 text-fg-primary">
            {copy.title}
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">{copy.description}</p>
        </div>
        {!isEditing && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="border-transparent text-fg-muted hover:text-fg-primary"
              loading={reconcileMutation.isPending}
              disabled={busy || !queryScope || (scope === 'project' && !projectId)}
              title="Read the machine list from the cloud account again. Machines you turned off stay off."
              aria-label="Refresh machine list"
              onClick={() => reconcileMutation.mutate()}
            >
              <RefreshCw
                size={14}
                aria-hidden
                className={reconcileMutation.isPending ? 'animate-spin' : undefined}
              />
              Refresh
            </Button>
            {canEdit && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>
            )}
          </div>
        )}
      </div>

      {query.isLoading && !query.data ? (
        <p className="m-0 text-sm text-fg-muted" role="status">
          Loading compute pool…
        </p>
      ) : (
        <>
          {query.isError && (
            <Alert variant="error">
              {query.error instanceof Error
                ? query.error.message
                : 'Failed to load the compute pool'}
            </Alert>
          )}
          {query.data &&
            (isEditing && ownedDefault ? (
              <ComputePoolEditor
                pool={ownedDefault.pool}
                groups={groups}
                saving={updateMutation.isPending}
                onCancel={() => setIsEditing(false)}
                onSave={(request) => {
                  if (request) updateMutation.mutate(request);
                  else setIsEditing(false);
                }}
              />
            ) : shown ? (
              <ComputePoolOverview
                summary={shown}
                groups={groups}
                projectId={projectId}
                notice={
                  fallbackScope && fallbackScope !== scope ? (
                    <FallbackNotice fallbackScope={fallbackScope} projectId={projectId} />
                  ) : undefined
                }
              />
            ) : (
              <ComputePoolEmptyState
                scope={scope}
                projectId={projectId}
                shared={query.data.effectiveSummary}
              />
            ))}
        </>
      )}

      {query.isFetching && query.data && !isEditing && (
        <p className="m-0 text-xs text-fg-muted" role="status">
          Refreshing…
        </p>
      )}
    </section>
  );
}
