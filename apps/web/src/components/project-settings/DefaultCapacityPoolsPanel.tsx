import type {
  CapacityExhaustionPolicy,
  CapacityPoolCandidate,
  CapacityPoolScope,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
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

const SCOPE_LABELS: Record<CapacityPoolScope, string> = {
  project: 'Project',
  user: 'User',
  installation: 'Installation',
};

const MAX_VISIBLE_CANDIDATE_GROUPS = 12;

interface CandidateGroup {
  key: string;
  provider: string;
  location: string;
  runtime: string;
  machineClass: string;
  candidates: CapacityPoolCandidate[];
}

type CandidateStatusDraft = Record<string, CapacityPoolStatus>;

type DefaultCapacityPoolsPanelProps =
  | { scope?: 'project'; projectId: string }
  | { scope: 'user'; projectId?: never }
  | { scope: 'installation'; projectId?: never };

const PANEL_COPY: Record<
  CapacityPoolScope,
  { title: string; description: string; empty: string; success: string }
> = {
  project: {
    title: 'Project Default Compute Pool',
    description:
      'Controls the default pool SAM resolves for new work in this project. Project pools override user and installation defaults, and project-scoped nodes only pack work for this project.',
    empty:
      'Connect an active project cloud credential, then reconcile defaults. Without a project pool, SAM falls back to the user pool and then the installation pool.',
    success: 'Project default compute pool reconciled',
  },
  user: {
    title: 'Your Default Compute Pool',
    description:
      'Controls your personal default pool. SAM uses it when a project has no project-scoped pool, and your nodes can pack your work across multiple projects just like today.',
    empty:
      'Connect an active personal cloud credential, then reconcile defaults. Projects with their own pool override this personal default.',
    success: 'User default compute pool reconciled',
  },
  installation: {
    title: 'Installation Default Compute Pool',
    description:
      'Controls the SAM installation fallback pool. SAM uses this platform-admin pool when neither the project nor the user has a default pool.',
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

function groupCandidates(candidates: CapacityPoolCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();

  for (const candidate of candidates) {
    const provider = candidate.provider ?? 'unknown provider';
    const location = candidate.location ?? 'unknown region';
    const runtime = candidate.runtime ?? 'runtime not set';
    const machineClass = candidate.machineClass ?? 'class not set';
    const key = `${provider}:${location}:${runtime}:${machineClass}`;
    const existing =
      groups.get(key) ??
      ({
        key,
        provider,
        location,
        runtime,
        machineClass,
        candidates: [],
      } satisfies CandidateGroup);

    existing.candidates.push(candidate);
    groups.set(key, existing);
  }

  return [...groups.values()];
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
          <div className="text-fg-muted">Active candidates</div>
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
          {item.summary.activeCandidateCount} candidates · {formatLabel(item.summary.pool.strategy)}
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

function CandidatesList({ candidates }: { candidates: CapacityPoolCandidate[] }) {
  const groups = groupCandidates(candidates.filter((candidate) => candidate.status === 'active'));
  const visible = groups.slice(0, MAX_VISIBLE_CANDIDATE_GROUPS);
  const hiddenCount = groups.length - visible.length;

  if (groups.length === 0) {
    return <div className="text-xs text-fg-muted">No active machine candidates.</div>;
  }

  return (
    <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
      {visible.map((group) => (
        <div
          key={group.key}
          className="rounded-md border border-border-default bg-inset p-2 text-xs min-w-0"
        >
          <div className="font-medium text-fg-primary break-words">
            {formatLabel(group.provider)} · {group.location}
          </div>
          <div className="mt-1 text-fg-muted">
            {formatLabel(group.runtime)} · {formatLabel(group.machineClass)}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {group.candidates.map((candidate) => (
              <span
                key={candidate.id}
                className="rounded-full border border-border-default bg-bg-card px-2 py-0.5 text-fg-primary"
              >
                {candidate.machineSize ?? 'size not set'}
              </span>
            ))}
          </div>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="text-xs text-fg-muted">+{hiddenCount} more provider/region groups</div>
      )}
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

function CandidateEditor({
  candidates,
  draftStatuses,
  onStatusChange,
}: {
  candidates: CapacityPoolCandidate[];
  draftStatuses: CandidateStatusDraft;
  onStatusChange: (candidateId: string, status: CapacityPoolStatus) => void;
}) {
  const groups = groupCandidates(candidates);

  if (groups.length === 0) {
    return <div className="text-xs text-fg-muted">No machine candidates available to edit.</div>;
  }

  return (
    <div className="grid max-h-96 gap-2 overflow-y-auto pr-1">
      {groups.map((group) => (
        <div
          key={group.key}
          className="rounded-md border border-border-default bg-inset p-2 text-xs min-w-0"
        >
          <div className="font-medium text-fg-primary break-words">
            {formatLabel(group.provider)} · {group.location}
          </div>
          <div className="mt-1 text-fg-muted">
            {formatLabel(group.runtime)} · {formatLabel(group.machineClass)}
          </div>
          <div className="mt-2 grid gap-2">
            {group.candidates.map((candidate) => {
              const status = draftStatuses[candidate.id] ?? candidate.status;
              const isRemoved = status === 'deleted';
              return (
                <div
                  key={candidate.id}
                  className="flex flex-col gap-2 rounded border border-border-default bg-bg-card p-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border-default"
                      checked={status === 'active'}
                      disabled={isRemoved}
                      aria-label={`${formatLabel(candidate.provider)} ${group.location} ${formatLabel(candidate.machineSize)} candidate active`}
                      onChange={(event) =>
                        onStatusChange(
                          candidate.id,
                          event.currentTarget.checked ? 'active' : 'disabled'
                        )
                      }
                    />
                    <span className="font-medium text-fg-primary">
                      {candidate.machineSize ?? 'size not set'}
                    </span>
                    <span className="text-fg-muted">{formatLabel(status)}</span>
                  </label>
                  <Button
                    size="sm"
                    variant={isRemoved ? 'secondary' : 'ghost'}
                    className="w-full sm:w-auto"
                    aria-label={`${isRemoved ? 'Restore' : 'Remove'} ${formatLabel(candidate.provider)} ${group.location} ${formatLabel(candidate.machineSize)} candidate`}
                    onClick={() => onStatusChange(candidate.id, isRemoved ? 'active' : 'deleted')}
                  >
                    {isRemoved ? 'Restore' : 'Remove'}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function buildUpdateRequest(
  summary: DefaultCapacityPoolSummary,
  draftStrategy: CapacityPoolStrategy,
  draftExhaustionPolicy: CapacityExhaustionPolicy,
  draftStatuses: CandidateStatusDraft
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

  return request.policy || request.candidates ? request : null;
}

export function DefaultCapacityPoolsPanel(props: DefaultCapacityPoolsPanelProps) {
  const queryScope = useQueryScope();
  const toast = useToast();
  const queryClient = useQueryClient();
  const scope = props.scope ?? 'project';
  const projectId = scope === 'project' ? props.projectId : null;
  const queryKey =
    scope === 'project'
      ? capacityPoolQueryKeys.projectDefaults(queryScope, projectId ?? '')
      : scope === 'user'
        ? capacityPoolQueryKeys.userDefaults(queryScope)
        : capacityPoolQueryKeys.installationDefaults(queryScope);
  const queryFn = () =>
    scope === 'project'
      ? fetchProjectDefaultCapacityPools(projectId ?? '')
      : scope === 'user'
        ? fetchUserDefaultCapacityPools()
        : fetchInstallationDefaultCapacityPools();
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
    setIsEditing(true);
  };

  const saveEdits = () => {
    if (!ownedDefault) return;
    const request = buildUpdateRequest(
      ownedDefault,
      draftStrategy,
      draftExhaustionPolicy,
      draftCandidateStatuses
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
                  Disabled or removed candidates are excluded from placement. Reconcile adds new
                  catalog candidates without re-enabling candidates you changed here.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-xs text-fg-muted">
                  Strategy
                  <select
                    className="min-h-10 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
                    value={draftStrategy}
                    onChange={(event) =>
                      setDraftStrategy(event.currentTarget.value as CapacityPoolStrategy)
                    }
                  >
                    {CAPACITY_POOL_STRATEGIES.map((strategy) => (
                      <option key={strategy} value={strategy}>
                        {formatLabel(strategy)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-fg-muted">
                  Exhaustion policy
                  <select
                    className="min-h-10 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
                    value={draftExhaustionPolicy}
                    onChange={(event) =>
                      setDraftExhaustionPolicy(
                        event.currentTarget.value as CapacityExhaustionPolicy
                      )
                    }
                  >
                    {CAPACITY_EXHAUSTION_POLICIES.map((policy) => (
                      <option key={policy} value={policy}>
                        {formatLabel(policy)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-2 min-w-0">
                <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Provider, region, machine candidates
                </h4>
                <CandidateEditor
                  candidates={ownedDefault.candidates}
                  draftStatuses={draftCandidateStatuses}
                  onStatusChange={(candidateId, status) =>
                    setDraftCandidateStatuses((current) => ({
                      ...current,
                      [candidateId]: status,
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
                    Provider, Region, Machine Candidates
                  </h3>
                  <CandidatesList candidates={effective.candidates} />
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
