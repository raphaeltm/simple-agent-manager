/**
 * Insights (Insights slice F, idea 01M7HTS38KX2G78JD0ESAGMKKH): a project page with four tabs,
 * Flow, Agent setups, Accounts and People. Flow, Agent setups (slice S) and Accounts (slice A) are
 * live; People says it is coming until its slice (P in the spec) ships, which is the one
 * placeholder the spec allows.
 *
 * The header slab carries the range (7, 30 or 90 days, kept in `?range=` so a link keeps it)
 * and the tabs. Each tab is its own route under `/projects/:id/insights/`.
 */
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_RANGES,
  type InsightsRange,
  isInsightsRange,
} from '@simple-agent-manager/shared';
import { Pane, SegmentedControl, Spinner, type Tab, Tabs } from '@simple-agent-manager/ui';
import { useIsFetching } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { insightsQueryKeys } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';

export const INSIGHTS_TABS: Tab[] = [
  { id: 'flow', label: 'Flow', path: 'flow' },
  { id: 'agent-setups', label: 'Agent setups', path: 'agent-setups' },
  { id: 'accounts', label: 'Accounts', path: 'accounts' },
  { id: 'people', label: 'People', path: 'people' },
];

const RANGE_LABELS: Record<InsightsRange, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

/** Hoisted on purpose: a stable options array, built once. */
const RANGE_OPTIONS = INSIGHTS_RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }));

export interface InsightsOutletContext {
  range: InsightsRange;
}

/** The range a tab reads, from the Insights layout. */
export function useInsightsRange(): InsightsRange {
  return useOutletContext<InsightsOutletContext>().range;
}

export function rangeLabel(range: InsightsRange): string {
  return RANGE_LABELS[range];
}

export function ProjectInsights() {
  const { projectId, project } = useProjectContext();
  const [params, setParams] = useSearchParams();
  const raw = params.get('range');
  const range: InsightsRange = isInsightsRange(raw) ? raw : DEFAULT_INSIGHTS_RANGE;
  const setRange = useCallback(
    (next: InsightsRange) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set('range', next);
          return updated;
        },
        { replace: true }
      ),
    [setParams]
  );
  const outletContext = useMemo<InsightsOutletContext>(() => ({ range }), [range]);
  const isMobile = useIsMobile();
  // A background refresh shows here, in the header, so it never shifts the figures below.
  const refreshing = useIsFetching({ queryKey: insightsQueryKeys.all(useQueryScope()) }) > 0;

  return (
    <div
      className="flex w-full min-w-0 flex-col gap-[var(--sam-space-gutter)] pb-6"
      data-testid="project-insights"
    >
      <Pane variant="slab" as="header" className="flex min-w-0 flex-col gap-3 px-4 pt-3.5 sm:px-5">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="m-0 text-[22px] font-bold text-fg-primary sm:text-[24px]">Insights</h1>
            <p className="m-0 mt-1 text-[13.5px] text-fg-muted [overflow-wrap:anywhere]">
              {project?.name ? `${project.name} · ` : ''}how work moves from idea to merged
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
            {refreshing && (
              <span role="status" aria-label="Updating" className="flex">
                <Spinner size="sm" />
              </span>
            )}
            <SegmentedControl<InsightsRange>
              label="Range"
              value={range}
              onChange={setRange}
              options={RANGE_OPTIONS}
              size={isMobile ? 'lg' : 'md'}
              className="w-full sm:w-[280px]"
            />
          </div>
        </div>
        <Tabs tabs={INSIGHTS_TABS} basePath={`/projects/${projectId}/insights`} />
      </Pane>
      <Outlet context={outletContext} />
    </div>
  );
}
