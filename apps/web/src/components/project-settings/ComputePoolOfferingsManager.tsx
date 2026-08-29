import type {
  CapacityPoolCandidate,
  CapacityPoolStatus,
  ProviderCatalog,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type ReactNode, useMemo, useState } from 'react';

import {
  buildComputePoolOfferingsModel,
  type ComputePoolCandidateOffering,
  type ComputePoolCatalogOffering,
  type ComputePoolOffering,
  type ComputePoolOfferingFilters,
  formatOfferingNumber,
  matchesComputePoolFilters,
} from '../../lib/compute-pool-offerings';

const DEFAULT_FILTERS: ComputePoolOfferingFilters = {
  provider: 'all',
  location: '',
  minVcpu: '',
  minRamGb: '',
  maxMonthlyPrice: '',
  availability: 'all',
};

function statusClasses(offering: ComputePoolOffering, status: string) {
  if (offering.stale) {
    return 'border-warning/30 bg-warning-tint text-fg-primary';
  }
  if (offering.available === false) {
    return 'border-danger/30 bg-danger/10 text-danger';
  }
  if (status === 'active') {
    return 'border-success/30 bg-success-tint text-success-fg';
  }
  if (status === 'deleted' || status === 'disabled') {
    return 'border-border-default bg-inset text-fg-muted';
  }
  return 'border-border-default bg-bg-card text-fg-muted';
}

function availabilityLabel(offering: ComputePoolOffering, status: string) {
  if (offering.stale) return 'Stale catalog data';
  if (offering.available === false) return offering.statusLabel ?? 'Unavailable';
  if (status === 'active') return 'Allowed';
  if (status === 'deleted') return 'Removed';
  if (status === 'disabled') return 'Disabled';
  if (status === 'not-configured') return 'Catalog only';
  return offering.statusLabel ?? 'Available';
}

function OfferingSpecGrid({ offering }: { offering: ComputePoolOffering }) {
  return (
    <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div className="min-w-0">
        <dt className="text-fg-muted">vCPU</dt>
        <dd className="m-0 font-medium text-fg-primary">{formatOfferingNumber(offering.vcpu, '')}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-fg-muted">RAM</dt>
        <dd className="m-0 font-medium text-fg-primary">
          {formatOfferingNumber(offering.ramGb, 'GB')}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-fg-muted">Disk</dt>
        <dd className="m-0 font-medium text-fg-primary">
          {formatOfferingNumber(offering.diskGb, 'GB')}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-fg-muted">Price</dt>
        <dd className="m-0 font-medium text-fg-primary break-words">
          {offering.priceLabel ?? 'Price unavailable'}
        </dd>
      </div>
    </dl>
  );
}

function OfferingCard({
  offering,
  status,
  action,
  isRemoved = false,
  metadata,
}: {
  offering: ComputePoolOffering;
  status: string;
  action?: ReactNode;
  isRemoved?: boolean;
  metadata?: ReactNode;
}) {
  return (
    <article
      className={`grid min-w-0 gap-3 rounded-md border p-3 ${
        isRemoved
          ? 'border-border-default bg-inset opacity-80'
          : 'border-border-default bg-bg-card'
      }`}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h5
              className={`m-0 text-sm font-semibold text-fg-primary break-all ${
                isRemoved ? 'line-through decoration-fg-muted decoration-2' : ''
              }`}
            >
              {offering.sku}
            </h5>
            <span
              className={`rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium ${statusClasses(
                offering,
                status
              )}`}
            >
              {availabilityLabel(offering, status)}
            </span>
          </div>
          <p className="m-0 mt-1 text-xs text-fg-muted break-words">
            {offering.providerLabel} · {offering.locationLabel}
            {offering.locationLabel !== offering.location ? ` (${offering.location})` : ''}
            {offering.country ? ` · ${offering.country}` : ''}
          </p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <OfferingSpecGrid offering={offering} />
      {metadata && <div className="text-xs text-fg-muted break-words">{metadata}</div>}
    </article>
  );
}

function CandidateOfferingCard({
  offering,
  actionLabel,
  actionStatus,
  onStatusChange,
  isRemoved,
}: {
  offering: ComputePoolCandidateOffering;
  actionLabel?: string;
  actionStatus?: CapacityPoolStatus;
  onStatusChange: (candidateId: string, status: CapacityPoolStatus) => void;
  isRemoved?: boolean;
}) {
  const ariaLabel =
    actionLabel && actionStatus
      ? `${actionLabel} ${offering.providerLabel} ${offering.location} ${offering.sku}`
      : null;
  const metadata = [offering.runtime, offering.machineClass].filter(Boolean).join(' · ');

  return (
    <OfferingCard
      offering={offering}
      status={offering.candidateStatus}
      isRemoved={isRemoved}
      metadata={metadata ? `Runtime/class: ${metadata}` : undefined}
      action={
        ariaLabel && actionStatus ? (
          <Button
            size="sm"
            variant={actionStatus === 'deleted' ? 'secondary' : 'primary'}
            className="w-full sm:w-auto"
            aria-label={ariaLabel}
            onClick={() => onStatusChange(offering.candidateId, actionStatus)}
          >
            {actionLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

function CatalogOfferingCard({
  offering,
  onStatusChange,
}: {
  offering: ComputePoolCatalogOffering;
  onStatusChange: (candidateId: string, status: CapacityPoolStatus) => void;
}) {
  let action: ReactNode;
  if (offering.candidateStatus === 'active') {
    action = (
      <Button size="sm" variant="ghost" className="w-full sm:w-auto" disabled>
        Already allowed
      </Button>
    );
  } else if (offering.candidateId) {
    const candidateId = offering.candidateId;
    action = (
      <Button
        size="sm"
        className="w-full sm:w-auto"
        aria-label={`Add ${offering.providerLabel} ${offering.location} ${offering.sku}`}
        onClick={() => onStatusChange(candidateId, 'active')}
      >
        Add
      </Button>
    );
  } else {
    action = (
      <Button
        size="sm"
        variant="ghost"
        className="w-full sm:w-auto"
        disabled
        aria-label={`Cannot add ${offering.providerLabel} ${offering.location} ${offering.sku} until backend add support lands`}
      >
        Needs backend
      </Button>
    );
  }

  const metadata = [offering.runtime, offering.machineClass].filter(Boolean).join(' · ');

  return (
    <OfferingCard
      offering={offering}
      status={offering.candidateStatus}
      action={action}
      metadata={metadata ? `Runtime/class: ${metadata}` : undefined}
    />
  );
}

function FilterControls({
  filters,
  providers,
  onChange,
  onReset,
}: {
  filters: ComputePoolOfferingFilters;
  providers: Array<{ id: string; label: string }>;
  onChange: (filters: ComputePoolOfferingFilters) => void;
  onReset: () => void;
}) {
  const update = <Key extends keyof ComputePoolOfferingFilters>(
    key: Key,
    value: ComputePoolOfferingFilters[Key]
  ) => onChange({ ...filters, [key]: value });

  return (
    <div className="grid gap-3 rounded-md border border-border-default bg-inset p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="m-0 text-sm font-medium text-fg-primary">Catalog filters</h4>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Narrow by provider, region, CPU, memory, and price where the catalog has metadata.
          </p>
        </div>
        <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={onReset}>
          Reset filters
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <label className="grid gap-1 text-xs text-fg-muted">
          Provider
          <select
            aria-label="Filter provider"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.provider}
            onChange={(event) => update('provider', event.currentTarget.value)}
          >
            <option value="all">All providers</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs text-fg-muted lg:col-span-2">
          Region / location
          <input
            aria-label="Filter region or location"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.location}
            onChange={(event) => update('location', event.currentTarget.value)}
            placeholder="fsn1, Ashburn, DE…"
          />
        </label>

        <label className="grid gap-1 text-xs text-fg-muted">
          Min vCPU
          <input
            aria-label="Minimum vCPU"
            type="number"
            min="0"
            inputMode="numeric"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.minVcpu}
            onChange={(event) => update('minVcpu', event.currentTarget.value)}
          />
        </label>

        <label className="grid gap-1 text-xs text-fg-muted">
          Min RAM
          <input
            aria-label="Minimum RAM in GB"
            type="number"
            min="0"
            inputMode="decimal"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.minRamGb}
            onChange={(event) => update('minRamGb', event.currentTarget.value)}
          />
        </label>

        <label className="grid gap-1 text-xs text-fg-muted">
          Max price
          <input
            aria-label="Maximum monthly price"
            type="number"
            min="0"
            inputMode="decimal"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.maxMonthlyPrice}
            onChange={(event) => update('maxMonthlyPrice', event.currentTarget.value)}
          />
        </label>

        <label className="grid gap-1 text-xs text-fg-muted sm:col-span-2 lg:col-span-2">
          Availability
          <select
            aria-label="Filter availability"
            className="min-h-10 w-full min-w-0 rounded-md border border-border-default bg-bg-card px-3 text-sm text-fg-primary"
            value={filters.availability}
            onChange={(event) =>
              update(
                'availability',
                event.currentTarget.value as ComputePoolOfferingFilters['availability']
              )
            }
          >
            <option value="all">All catalog rows</option>
            <option value="available">Available rows</option>
            <option value="unavailable">Unavailable rows</option>
            <option value="stale">Stale rows</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function EmptyOfferingState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border-default bg-inset p-4 text-sm text-fg-muted">
      {children}
    </div>
  );
}

interface ComputePoolOfferingsManagerProps {
  candidates: CapacityPoolCandidate[];
  catalogs: ProviderCatalog[];
  draftStatuses?: Record<string, CapacityPoolStatus>;
  isEditing: boolean;
  onStatusChange: (candidateId: string, status: CapacityPoolStatus) => void;
}

export function ComputePoolOfferingsManager({
  candidates,
  catalogs,
  draftStatuses = {},
  isEditing,
  onStatusChange,
}: ComputePoolOfferingsManagerProps) {
  const [filters, setFilters] = useState<ComputePoolOfferingFilters>(DEFAULT_FILTERS);
  const model = useMemo(
    () => buildComputePoolOfferingsModel(candidates, catalogs, draftStatuses),
    [candidates, catalogs, draftStatuses]
  );
  const providers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const offering of [...model.allowed, ...model.excluded, ...model.catalog]) {
      byId.set(offering.provider, offering.providerLabel);
    }
    return [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [model.allowed, model.catalog, model.excluded]);

  const filteredCatalog = model.catalog.filter((offering) =>
    matchesComputePoolFilters(offering, filters)
  );
  const filteredAllowed = model.allowed.filter((offering) =>
    matchesComputePoolFilters(offering, filters)
  );
  const addableCatalog = filteredCatalog.filter(
    (offering) => offering.candidateId && offering.candidateStatus !== 'active'
  );
  const removableAllowed = filteredAllowed.filter((offering) => offering.candidateStatus === 'active');
  const filteredRegionCount = new Set(
    filteredCatalog.map((offering) => `${offering.provider}:${offering.location}`)
  ).size;

  return (
    <div className="grid gap-4 min-w-0">
      <section className="grid gap-2 min-w-0">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Allowed instances
            </h4>
            <p className="m-0 mt-1 text-xs text-fg-muted">
              Concrete provider offerings SAM may place work on for this pool.
            </p>
          </div>
          <div className="text-xs text-fg-muted">
            {model.allowed.length} allowed · {model.excluded.length} removed/disabled
          </div>
        </div>

        {model.allowed.length === 0 ? (
          <EmptyOfferingState>No allowed instances are configured in this pool.</EmptyOfferingState>
        ) : (
          <div className="grid max-h-[28rem] gap-2 overflow-y-auto pr-1">
            {model.allowed.map((offering) => (
              <CandidateOfferingCard
                key={offering.candidateId}
                offering={offering}
                actionLabel={isEditing ? 'Remove' : undefined}
                actionStatus={isEditing ? 'deleted' : undefined}
                onStatusChange={onStatusChange}
              />
            ))}
          </div>
        )}
      </section>

      {model.excluded.length > 0 && (
        <section className="grid gap-2 min-w-0">
          <h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Removed or disabled instances
          </h4>
          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
            {model.excluded.map((offering) => (
              <CandidateOfferingCard
                key={offering.candidateId}
                offering={offering}
                actionLabel={isEditing ? 'Add back' : undefined}
                actionStatus={isEditing ? 'active' : undefined}
                onStatusChange={onStatusChange}
                isRemoved
              />
            ))}
          </div>
        </section>
      )}

      {isEditing && (
        <section className="grid gap-3 min-w-0">
          <FilterControls
            filters={filters}
            providers={providers}
            onChange={setFilters}
            onReset={() => setFilters(DEFAULT_FILTERS)}
          />

          <div className="rounded-md border border-border-default bg-inset p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h4 className="m-0 text-sm font-medium text-fg-primary">
                  Add instances from catalog
                </h4>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  {filteredCatalog.length} matching offering
                  {filteredCatalog.length === 1 ? '' : 's'} across {filteredRegionCount} region
                  {filteredRegionCount === 1 ? '' : 's'}.
                </p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full sm:w-auto"
                  disabled={addableCatalog.length === 0}
                  onClick={() => {
                    for (const offering of addableCatalog) {
                      if (offering.candidateId) onStatusChange(offering.candidateId, 'active');
                    }
                  }}
                >
                  Add filtered
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full sm:w-auto"
                  disabled={removableAllowed.length === 0}
                  onClick={() => {
                    for (const offering of removableAllowed) {
                      onStatusChange(offering.candidateId, 'deleted');
                    }
                  }}
                >
                  Remove filtered allowed
                </Button>
              </div>
            </div>

            <div className="mt-3 grid max-h-[32rem] gap-2 overflow-y-auto pr-1">
              {filteredCatalog.length === 0 ? (
                <EmptyOfferingState>No catalog offerings match the current filters.</EmptyOfferingState>
              ) : (
                filteredCatalog.map((offering) => (
                  <CatalogOfferingCard
                    key={offering.key}
                    offering={offering}
                    onStatusChange={onStatusChange}
                  />
                ))
              )}
            </div>
          </div>

          {model.catalog.some((offering) => !offering.canUpdateExistingCandidate) && (
            <div className="rounded-md border border-warning/30 bg-warning-tint p-3 text-xs text-fg-muted">
              Catalog offerings without an existing backend pool row are shown for discovery, but
              adding them requires the backend provider-native add mutation that is landing in the
              compute-pools integration work.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
