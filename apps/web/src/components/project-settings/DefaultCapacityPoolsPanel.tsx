import type {
  CapacityPoolCandidate,
  CapacityPoolScope,
  CapacitySourceIdentity,
  DefaultCapacityPoolScopeSummary,
  DefaultCapacityPoolSummary,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import {
  fetchInstallationDefaultCapacityPools,
  fetchProjectDefaultCapacityPools,
  fetchUserDefaultCapacityPools,
  reconcileInstallationDefaultCapacityPools,
  reconcileProjectDefaultCapacityPools,
  reconcileUserDefaultCapacityPools,
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
  machineSizes: string[];
}

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
        machineSizes: [],
      } satisfies CandidateGroup);

    if (candidate.machineSize && !existing.machineSizes.includes(candidate.machineSize)) {
      existing.machineSizes.push(candidate.machineSize);
    }
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
            {SCOPE_LABELS[summary.pool.scope]} default applies first for this context.
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
    const reason =
      item.visibilityReason === 'superadmin-required'
        ? 'Hidden. Installation defaults require superadmin access.'
        : 'Hidden outside this settings context.';

    return (
      <div className="rounded-md border border-dashed border-border-default p-3 min-w-0">
        <div className="text-sm font-medium text-fg-primary">{SCOPE_LABELS[item.scope]}</div>
        <div className="text-xs text-fg-muted">{reason}</div>
      </div>
    );
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
  const groups = groupCandidates(candidates);
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
            {group.machineSizes.map((size) => (
              <span
                key={size}
                className="rounded-full border border-border-default bg-bg-card px-2 py-0.5 text-fg-primary"
              >
                {size}
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

  return (
    <section className="glass-surface rounded-lg p-4 grid gap-3 min-w-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between min-w-0">
        <div className="min-w-0">
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            {PANEL_COPY[scope].title}
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">{PANEL_COPY[scope].description}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="w-full sm:w-auto"
          loading={reconcileMutation.isPending}
          disabled={
            reconcileMutation.isPending || !queryScope || (scope === 'project' && !projectId)
          }
          onClick={() => reconcileMutation.mutate()}
        >
          Reconcile
        </Button>
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

          <EffectivePoolCard scope={scope} summary={effective} />

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 min-w-0">
            {(query.data?.defaults ?? []).map((item) => (
              <ScopeRow key={item.scope} item={item} />
            ))}
          </div>

          {effective && (
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
