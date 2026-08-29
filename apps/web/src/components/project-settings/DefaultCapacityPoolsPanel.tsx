import type {
  CapacityExhaustionPolicy,
  CapacityPoolScope,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
  DefaultCapacityPoolCandidateCatalogAddition,
  DefaultCapacityPoolScopeSummary,
  DefaultCapacityPoolSummary,
  DefaultCapacityPoolUpdateRequest,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import {
  CAPACITY_EXHAUSTION_POLICIES,
  CAPACITY_POOL_STRATEGIES,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { capacityPoolQueryKeys } from '../../lib/query-options/capacity-pools';
import { ComputePoolOfferingsManager } from './ComputePoolOfferingsManager';

const SCOPE_LABELS: Record<CapacityPoolScope, string> = {
  project: 'Project',
  user: 'User',
  installation: 'Installation',
};

type CandidateStatusDraft = Record<string, CapacityPoolStatus>;
type CatalogAdditionDraft = Record<string, DefaultCapacityPoolCandidateCatalogAddition>;

type DefaultCapacityPoolsPanelProps =
  | { scope?: 'project'; projectId: string }
  | { scope: 'user'; projectId?: never }
  | { scope: 'installation'; projectId?: never };

const PANEL_COPY: Record<
  CapacityPoolScope,
  { title: string; description: string; empty: string; success: string }
> = {
  project: {
    title: 'Project Infrastructure Compute Pool',
    description:
      'Controls the default infrastructure pool SAM resolves for new work in this project. Project pools override user and installation defaults, and project-scoped nodes only pack work for this project.',
    empty:
      'Connect an active project cloud credential, then reconcile defaults. Without a project pool, SAM falls back to the user pool and then the installation pool.',
    success: 'Project default compute pool reconciled',
  },
  user: {
    title: 'Your Infrastructure Compute Pool',
    description:
      'Controls your personal infrastructure pool. SAM uses it when a project has no project-scoped pool, and your nodes can pack your work across multiple projects just like today.',
    empty:
      'Connect an active personal cloud credential, then reconcile defaults. Projects with their own pool override this personal default.',
    success: 'User default compute pool reconciled',
  },
  installation: {
    title: 'Installation Infrastructure Compute Pool',
    description:
      'Controls the SAM installation infrastructure fallback pool. SAM uses this platform-admin pool when neither the project nor the user has a default pool.',
    empty:
      'Add and enable a platform cloud credential, then reconcile defaults. This fallback remains superadmin-only.',
    success: 'Installation default compute pool reconciled',
  },
};

function formatLabel(value: string | null | undefined): string {
  if (!value) return 'Not set';
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sourceReference(source: CapacitySourceIdentity): string {
  return (
    source.credentialReference ??
    source.credentialId ??
    source.platformCredentialId ??
    source.externalSourceRef ??
    'reference unavailable'
  );
}

function EffectivePoolCard({
  scope,
  summary,
}: {
  scope: CapacityPoolScope;
  summary: DefaultCapacityPoolSummary | null;
}) {
  if (!summary) {
    return (
      <div className="rounded-md border border-border-default bg-inset p-3 min-w-0">
        <div className="text-sm font-medium text-fg-primary">No visible active default pool</div>
        <p className="m-0 mt-1 text-xs text-fg-muted">{PANEL_COPY[scope].empty}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-accent bg-accent-tint p-3 min-w-0">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg-primary break-words">
            {summary.pool.name}
          </div>
          <div className="text-xs text-fg-muted">
            {summary.pool.scope === scope
              ? `${SCOPE_LABELS[summary.pool.scope]} default applies to this context.`
              : `${SCOPE_LABELS[summary.pool.scope]} default is the current read-only fallback for this context.`}
          </div>
        </div>
        <div className="text-xs text-fg-muted sm:text-right shrink-0">
          revision {summary.pool.revision} · {formatLabel(summary.pool.status)}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
        <div>
          <div className="text-fg-muted">Strategy</div>
          <div className="font-medium text-fg-primary">{formatLabel(summary.pool.strategy)}</div>
        </div>
        <div>
          <div className="text-fg-muted">Exhaustion</div>
          <div className="font-medium text-fg-primary">
            {formatLabel(summary.pool.exhaustionPolicy)}
          </div>
        </div>
        <div>
          <div className="text-fg-muted">Allowed instances</div>
          <div className="font-medium text-fg-primary">{summary.activeCandidateCount}</div>
        </div>
      </div>
    </div>
  );
}

function ScopeRow({ item }: { item: DefaultCapacityPoolScopeSummary }) {
  if (item.visibility === 'hidden') {
    return null;
  }

  return (
    <div className="rounded-md border border-border-default p-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-fg-primary">{SCOPE_LABELS[item.scope]}</div>
        <div className="text-xs text-fg-muted">
          {item.summary ? formatLabel(item.summary.pool.status) : 'No active pool'}
        </div>
      </div>
      {item.summary ? (
        <div className="mt-1 text-xs text-fg-muted">
          {item.summary.sources.length} source{item.summary.sources.length === 1 ? '' : 's'} ·{' '}
          {item.summary.activeCandidateCount} allowed instances ·{' '}
          {formatLabel(item.summary.pool.strategy)}
        </div>
      ) : (
        <div className="mt-1 text-xs text-fg-muted">
          No active credentials resolved for this scope.
        </div>
      )}
    </div>
  );
}

function SourcesList({ sources }: { sources: CapacitySourceIdentity[] }) {
  if (sources.length === 0) {
    return <div className="text-xs text-fg-muted">No active sources.</div>;
  }

  return (
    <div className="grid gap-2">
      {sources.map((source) => (
        <div
          key={source.id}
          className="rounded-md border border-border-default bg-inset p-2 text-xs min-w-0"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="font-medium text-fg-primary">
              {formatLabel(source.provider)} · {formatLabel(source.credentialSource)}
            </div>
            <div className="text-fg-muted">{formatLabel(source.status)}</div>
          </div>
          <div className="mt-1 break-all text-fg-muted">{sourceReference(source)}</div>
        </div>
      ))}
    </div>
  );
}

function FallbackNotice({
  scope,
  effective,
}: {
  scope: CapacityPoolScope;
  effective: DefaultCapacityPoolSummary | null;
}) {
  if (!effective || effective.pool.scope === scope) return null;

  return (
    <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-xs text-fg-muted">
      <span className="font-medium text-fg-primary">
        Using {SCOPE_LABELS[effective.pool.scope].toLowerCase()} fallback.
      </span>{' '}
      This page can edit only the {SCOPE_LABELS[scope].toLowerCase()} default pool. Reconcile this
      scope after connecting matching credentials to create an editable default that takes
      precedence.
    </div>
  );
}

function credentialSetupHref(scope: CapacityPoolScope, projectId: string | null): string {
  if (scope === 'project') return `/projects/${projectId ?? ''}/settings/connections`;
  if (scope === 'user') return '/settings/cloud-provider';
  return '/admin/credentials';
}

function CredentialSetupCard({
  scope,
  projectId,
  hasEffectiveFallback,
}: {
  scope: CapacityPoolScope;
  projectId: string | null;
  hasEffectiveFallback: boolean;
}) {
  const copy: Record<CapacityPoolScope, { title: string; body: string; action: string }> = {
    project: {
      title: hasEffectiveFallback
        ? 'Create a project-scoped infrastructure pool'
        : 'Project compute credentials are required',
      body:
        'A project pool needs compute provider credentials that a user connects and grants for this project. It works like project-scoped AI/API keys: the credential is user-managed, but the project can use it for infrastructure placement.',
      action: 'Set up project credentials',
    },
    user: {
      title: 'Personal compute credentials are required',
      body:
        'Connect a cloud provider credential before creating your personal infrastructure pool.',
      action: 'Set up cloud provider',
    },
    installation: {
      title: 'Platform compute credentials are required',
      body:
        'Add and enable an installation cloud-provider credential before creating the installation fallback pool.',
      action: 'Set up platform credentials',
    },
  };

  if (scope === 'project' && !projectId) return null;

  return (
    <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-sm">
      <div className="font-medium text-fg-primary">{copy[scope].title}</div>
      <p className="m-0 mt-1 text-xs text-fg-muted">{copy[scope].body}</p>
      <Link
        to={credentialSetupHref(scope, projectId)}
        className="mt-3 inline-flex min-h-9 w-full items-center justify-center rounded-md border border-border-default bg-surface px-3 text-sm font-semibold text-fg-primary transition-all hover:bg-[var(--sam-button-secondary-hover-bg)] sm:w-auto"
      >
        {copy[scope].action}
      </Link>
    </div>
  );
}

function PolicySelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-1 text-xs text-fg-muted">
      {label}
      <select
        className="min-h-10 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {formatLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildUpdateRequest(
  summary: DefaultCapacityPoolSummary,
  draftStrategy: CapacityPoolStrategy,
  draftExhaustionPolicy: CapacityExhaustionPolicy,
  draftStatuses: CandidateStatusDraft,
  draftCatalogAdditions: CatalogAdditionDraft
): DefaultCapacityPoolUpdateRequest | null {
  const policy: DefaultCapacityPoolUpdateRequest['policy'] = {};
  if (draftStrategy !== summary.pool.strategy) policy.strategy = draftStrategy;
  if (draftExhaustionPolicy !== summary.pool.exhaustionPolicy) {
    policy.exhaustionPolicy = draftExhaustionPolicy;
  }

  const candidates = summary.candidates.flatMap((candidate) => {
    const status = draftStatuses[candidate.id] ?? candidate.status;
    if (status === candidate.status) return [];
    return [{ id: candidate.id, status }];
  });

  const request: DefaultCapacityPoolUpdateRequest = {};
  if (policy.strategy || policy.exhaustionPolicy) request.policy = policy;
  if (candidates.length > 0) request.candidates = candidates;
  const catalogAdditions = Object.values(draftCatalogAdditions);
  if (catalogAdditions.length > 0) request.catalogAdditions = catalogAdditions;

  return request.policy || request.candidates || request.catalogAdditions ? request : null;
}

export function DefaultCapacityPoolsPanel(props: DefaultCapacityPoolsPanelProps) {
  const queryScope = useQueryScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const scope = props.scope ?? 'project';
  const projectId = scope === 'project' ? (props.projectId ?? null) : null;
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
  const queryFn = () =>
    scope === 'project'
      ? fetchProjectDefaultCapacityPools(projectId ?? '', { ensure: true })
      : scope === 'user'
        ? fetchUserDefaultCapacityPools({ ensure: true })
        : fetchInstallationDefaultCapacityPools({ ensure: true });
  const query = useQuery<ProjectDefaultCapacityPoolsResponse>({
    queryKey,
    queryFn,
    enabled: Boolean(queryScope),
  });
  const effective = query.data?.effective ?? null;
  const ownedDefault =
    query.data?.defaults.find((item) => item.scope === scope && item.visibility === 'visible')
      ?.summary ?? null;
  const visibleDefaults =
    query.data?.defaults.filter((item) => item.visibility === 'visible') ?? [];
  const canEditOwnedDefault = Boolean(query.data?.policyMutationSupported && ownedDefault);
  const [isEditing, setIsEditing] = useState(false);
  const [draftStrategy, setDraftStrategy] = useState<CapacityPoolStrategy>(
    CAPACITY_POOL_STRATEGIES[0]
  );
  const [draftExhaustionPolicy, setDraftExhaustionPolicy] = useState<CapacityExhaustionPolicy>(
    CAPACITY_EXHAUSTION_POLICIES[0]
  );
  const [draftCandidateStatuses, setDraftCandidateStatuses] = useState<CandidateStatusDraft>({});
  const [draftCatalogAdditions, setDraftCatalogAdditions] = useState<CatalogAdditionDraft>({});

  const reconcileMutation = useMutation({
    mutationFn: () =>
      scope === 'project'
        ? reconcileProjectDefaultCapacityPools(projectId ?? '')
        : scope === 'user'
          ? reconcileUserDefaultCapacityPools()
          : reconcileInstallationDefaultCapacityPools(),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.success(PANEL_COPY[scope].success);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to reconcile compute pools');
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
      setDraftCandidateStatuses({});
      setDraftCatalogAdditions({});
      toast.success(`${SCOPE_LABELS[scope]} default compute pool updated`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update compute pool');
    },
  });

  const startEditing = () => {
    if (!ownedDefault) return;
    setDraftStrategy(ownedDefault.pool.strategy);
    setDraftExhaustionPolicy(ownedDefault.pool.exhaustionPolicy);
    setDraftCandidateStatuses(
      Object.fromEntries(
        ownedDefault.candidates.map((candidate) => [candidate.id, candidate.status])
      )
    );
    setDraftCatalogAdditions({});
    setIsEditing(true);
  };

  const saveEdits = () => {
    if (!ownedDefault) return;
    const request = buildUpdateRequest(
      ownedDefault,
      draftStrategy,
      draftExhaustionPolicy,
      draftCandidateStatuses,
      draftCatalogAdditions
    );
    if (!request) {
      setIsEditing(false);
      return;
    }
    updateMutation.mutate(request);
  };

  return (
    <section className="glass-surface rounded-lg p-4 grid gap-3 min-w-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between min-w-0">
        <div className="min-w-0">
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            {PANEL_COPY[scope].title}
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">{PANEL_COPY[scope].description}</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {canEditOwnedDefault && !isEditing && (
            <Button
              size="sm"
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={updateMutation.isPending || reconcileMutation.isPending}
              onClick={startEditing}
            >
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="w-full sm:w-auto"
            loading={reconcileMutation.isPending}
            disabled={
              reconcileMutation.isPending ||
              updateMutation.isPending ||
              isEditing ||
              !queryScope ||
              (scope === 'project' && !projectId)
            }
            onClick={() => reconcileMutation.mutate()}
          >
            Reconcile
          </Button>
        </div>
      </div>

      {query.isLoading && !query.data ? (
        <div className="rounded-md border border-border-default bg-inset p-3 text-sm text-fg-muted">
          Loading default compute pool…
        </div>
      ) : (
        <>
          {query.isError && (
            <div className="rounded-md border border-danger bg-danger/10 p-3 text-sm text-danger">
              {query.error instanceof Error
                ? query.error.message
                : 'Failed to load default compute pool'}
            </div>
          )}

          {query.data && (
            <>
              <EffectivePoolCard scope={scope} summary={effective} />
              <FallbackNotice scope={scope} effective={effective} />
              {!ownedDefault && (
                <CredentialSetupCard
                  scope={scope}
                  projectId={projectId}
                  hasEffectiveFallback={Boolean(effective)}
                />
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 min-w-0">
                {visibleDefaults.map((item) => (
                  <ScopeRow key={item.scope} item={item} />
                ))}
              </div>
            </>
          )}

          {isEditing && ownedDefault ? (
            <div className="grid gap-3 rounded-md border border-accent bg-accent-tint p-3 min-w-0">
              <div>
                <h3 className="m-0 text-sm font-medium text-fg-primary">
                  Edit {SCOPE_LABELS[scope].toLowerCase()} default
                </h3>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  Add or remove concrete provider offerings. Reconcile refreshes provider catalog
                  rows without re-enabling offerings you removed here.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <PolicySelect
                  label="Strategy"
                  value={draftStrategy}
                  options={CAPACITY_POOL_STRATEGIES}
                  onChange={setDraftStrategy}
                />
                <PolicySelect
                  label="Exhaustion policy"
                  value={draftExhaustionPolicy}
                  options={CAPACITY_EXHAUSTION_POLICIES}
                  onChange={setDraftExhaustionPolicy}
                />
              </div>

              <div className="grid gap-2 min-w-0">
                <ComputePoolOfferingsManager
                  candidates={ownedDefault.candidates}
                  sources={ownedDefault.sources}
                  catalogs={providerCatalog.catalogs}
                  draftStatuses={draftCandidateStatuses}
                  draftCatalogAdditionKeys={new Set(Object.keys(draftCatalogAdditions))}
                  isEditing
                  onStatusChange={(candidateId, status) =>
                    setDraftCandidateStatuses((current) => ({
                      ...current,
                      [candidateId]: status,
                    }))
                  }
                  onCatalogAdd={(addition, key) =>
                    setDraftCatalogAdditions((current) => ({
                      ...current,
                      [key]: addition,
                    }))
                  }
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full sm:w-auto"
                  disabled={updateMutation.isPending}
                  onClick={() => {
                    setIsEditing(false);
                    setDraftCandidateStatuses({});
                    setDraftCatalogAdditions({});
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="w-full sm:w-auto"
                  loading={updateMutation.isPending}
                  disabled={updateMutation.isPending}
                  onClick={saveEdits}
                >
                  Save changes
                </Button>
              </div>
            </div>
          ) : (
            effective && (
              <div className="grid gap-3 lg:grid-cols-2 min-w-0">
                <div className="grid gap-2 min-w-0">
                  <h3 className="m-0 text-sm font-medium text-fg-primary">Active Sources</h3>
                  <SourcesList sources={effective.sources} />
                </div>
                <div className="grid gap-2 min-w-0">
                  <h3 className="m-0 text-sm font-medium text-fg-primary">
                    Provider-native allowed instances
                  </h3>
                  <ComputePoolOfferingsManager
                    candidates={effective.candidates}
                    sources={effective.sources}
                    catalogs={providerCatalog.catalogs}
                    isEditing={false}
                    onStatusChange={() => undefined}
                  />
                  {providerCatalog.isRefreshing && (
                    <div className="text-xs text-fg-muted" role="status">
                      Refreshing provider catalog…
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {query.isFetching && query.data && (
            <div className="text-xs text-fg-muted" role="status">
              Refreshing compute pool summary…
            </div>
          )}
        </>
      )}
    </section>
  );
}
