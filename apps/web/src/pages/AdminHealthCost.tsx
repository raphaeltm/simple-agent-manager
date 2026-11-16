/**
 * Admin › Health & cost (Insights slice H, idea 01M7HTS38KX2G78JD0ESAGMKKH): compute spend at
 * each machine's recorded price, machine reuse and packing, lifecycle latency against its
 * budgets, and why new machines were created. One read (`GET /api/admin/health-cost`), served
 * by the shared `installationHealth` operation.
 *
 * Stale-while-revalidate (`.claude/rules/48`): the spinner shows only before the first data; a
 * range change keeps the previous range on screen (`keepPreviousData`) with a quiet indicator.
 */
import {
  DEFAULT_INSTALLATION_HEALTH_RANGE,
  type InstallationHealthRange,
} from '@simple-agent-manager/shared';
import { Button, Pane, SegmentedControl, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import { adminHealthCostQueryOptions } from '../lib/query-options';
import { rangeLabel } from './admin-health-cost/format';
import { ReasonsPane, SpendPane, StatTiles } from './admin-health-cost/HealthCostSections';
import { LatencyPane } from './admin-health-cost/LatencyPane';

const RANGE_OPTIONS: { value: InstallationHealthRange; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'Month' },
];

const SECTION_NAMES: Record<string, string> = {
  compute: 'compute spend',
  reuse: 'machine reuse',
  density: 'agents per machine',
  newMachines: 'new-machine reasons',
  latency: 'lifecycle latency',
};

export function AdminHealthCost() {
  const scope = useQueryScope();
  const [range, setRange] = useState<InstallationHealthRange>(DEFAULT_INSTALLATION_HEALTH_RANGE);
  const query = useQuery({
    ...adminHealthCostQueryOptions(scope ?? '', range),
    enabled: Boolean(scope),
  });
  const data = query.data;
  const refreshing = query.isFetching && data !== undefined;

  return (
    <div
      className="flex w-full min-w-0 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="admin-health-cost"
    >
      <Pane
        variant="slab"
        as="header"
        className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
      >
        <div className="min-w-0">
          {/* h2: the Admin PageLayout already renders the page's h1. */}
          <h2 className="m-0 flex items-center gap-2 text-2xl font-bold text-fg-primary">
            Health &amp; cost {refreshing && <Spinner size="sm" />}
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            This installation · {data ? rangeLabel(data.window) : '…'} · compute costs are estimates
            at each machine&apos;s recorded provider price
          </p>
        </div>
        <SegmentedControl
          label="Range"
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          size="lg"
          className="w-full shrink-0 sm:w-72"
        />
      </Pane>

      {!data && query.isPending && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {!data && query.isError && (
        <Pane className="flex flex-col items-center gap-3 p-6 text-center" role="alert">
          <p className="m-0 text-sm text-danger-fg">
            Health &amp; cost could not be loaded: {query.error.message}
          </p>
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Pane>
      )}

      {data && (
        <>
          {query.isError && (
            <p className="m-0 text-sm text-danger-fg" role="status">
              Could not refresh: {query.error.message}. Showing the last result.
            </p>
          )}
          {data.unavailable.length > 0 && (
            <p className="m-0 text-sm text-fg-muted" role="status">
              Not available right now:{' '}
              {data.unavailable.map((s) => SECTION_NAMES[s] ?? s).join(', ')}.
            </p>
          )}
          <StatTiles
            rangeText={rangeLabel(data.window)}
            compute={data.compute}
            reuse={data.reuse}
            density={data.density}
          />
          <div className="grid grid-cols-1 gap-[var(--sam-space-gutter)] lg:grid-cols-2">
            <LatencyPane latency={data.latency} />
            <SpendPane compute={data.compute} />
            <ReasonsPane newMachines={data.newMachines} />
          </div>
        </>
      )}
    </div>
  );
}
