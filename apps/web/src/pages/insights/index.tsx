/**
 * Insights (Insights slice F, idea 01M7HTS38KX2G78JD0ESAGMKKH): a project page with four tabs,
 * Flow, Agent setups, Accounts and People. Flow is live; the other three say they are coming
 * until their slices (S, A, P in the spec) ship, which is the one placeholder the spec allows.
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
import { Pane, SegmentedControl, type Tab, Tabs } from '@simple-agent-manager/ui';
import { useCallback, useMemo } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router';

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
          <SegmentedControl<InsightsRange>
            label="Range"
            value={range}
            onChange={setRange}
            options={RANGE_OPTIONS}
            className="w-full shrink-0 sm:w-[280px]"
          />
        </div>
        <Tabs tabs={INSIGHTS_TABS} basePath={`/projects/${projectId}/insights`} />
      </Pane>
      <Outlet context={outletContext} />
    </div>
  );
}
