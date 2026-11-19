/**
 * Admin Health & cost: each lifecycle state's p95 in the range against its budget, rows stuck past
 * budget now, and the open incident for a state. Split from `HealthCostSections.tsx`.
 */
import type {
  InstallationLatencyState,
  InstallationLifecycleLatency,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { adminChartSeries } from '../admin-analytics/chartTokens';
import { formatDuration, lifecycleStateLabel, timeLabel } from './format';
import { PaneHead, Unavailable } from './pane-parts';

function LatencyRow({ state }: { state: InstallationLatencyState }) {
  const label = lifecycleStateLabel(state.entityType, state.status);
  const p95 = state.p95Ms ?? 0;
  const scale = Math.max(state.budgetMs, p95) * 1.15 || 1;
  const over = state.overBudget;
  // Phone: label and value share a line, the bar runs under them. From `sm`: label, bar, value.
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_5.5rem] sm:gap-y-0"
      data-testid="latency-row"
    >
      <span className="break-words text-[13px] text-fg-secondary">{label}</span>
      <div
        className="relative col-span-2 row-start-2 h-3 rounded-full bg-[var(--sam-hairline)] sm:col-span-1 sm:col-start-2 sm:row-start-1"
        aria-hidden="true"
      >
        {state.count > 0 && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${Math.min(100, (p95 / scale) * 100)}%`,
              background: over ? 'var(--sam-color-danger)' : adminChartSeries[0],
            }}
          />
        )}
        <div
          className="absolute -inset-y-1 w-0.5 rounded bg-fg-primary"
          style={{ left: `${(state.budgetMs / scale) * 100}%` }}
          data-testid="latency-budget-tick"
        />
      </div>
      <span
        className={`text-right font-mono text-xs sm:col-start-3 sm:row-start-1 ${over ? 'text-danger-fg font-semibold' : 'text-fg-muted'}`}
      >
        {state.count === 0 ? (
          <>
            no data
            <span className="sr-only">, budget {formatDuration(state.budgetMs)}</span>
          </>
        ) : (
          <>
            <span className="sr-only">p95 </span>
            {formatDuration(state.p95Ms)}
            {over && <span aria-hidden="true"> ✕</span>}
            <span className="sr-only">
              , budget {formatDuration(state.budgetMs)}, {state.count} episodes
              {over ? ', over budget' : ''}
            </span>
          </>
        )}
      </span>
    </li>
  );
}

function LatencyCallout({ state }: { state: InstallationLatencyState }) {
  const label = lifecycleStateLabel(state.entityType, state.status);
  const incident = state.incidents[0];
  const parts: ReactNode[] = [];
  if (state.overBudgetNow > 0) parts.push(`${state.overBudgetNow} past budget right now`);
  if (incident) {
    parts.push(
      `watchdog incident open since ${timeLabel(incident.firstSeenAt)} (${incident.occurrences} errors)`
    );
  }
  return (
    <div
      className="mx-4 flex items-start gap-2 rounded-[var(--sam-radius-control)] border border-danger bg-[color-mix(in_srgb,var(--sam-color-danger)_10%,transparent)] px-3 py-2 text-[13px] text-fg-primary"
      role="status"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger-fg" aria-hidden="true" />
      <span className="min-w-0 break-words">
        <b>
          {label} is {state.overBudget ? 'over budget' : 'running long'}.
        </b>{' '}
        {parts.join(' · ')}
        {incident?.ideaId && incident.ideaProjectId && (
          <>
            {' · '}
            <Link
              to={`/projects/${incident.ideaProjectId}/ideas/${incident.ideaId}`}
              className="inline-flex min-h-11 items-center font-medium text-accent-fg underline sm:min-h-0"
            >
              Open incident
            </Link>
          </>
        )}
      </span>
    </div>
  );
}

export function LatencyPane({ latency }: { latency: InstallationLifecycleLatency | null }) {
  const states = latency?.states ?? [];
  const flagged = states.filter(
    (s) => s.overBudget || s.overBudgetNow > 0 || s.incidents.length > 0
  );
  return (
    <Pane className="flex min-w-0 flex-col gap-3 pb-4" data-testid="latency-pane">
      <PaneHead
        title="Slowest 5% vs budget"
        right={
          <Link
            to="/admin/settings"
            className="inline-flex min-h-11 items-center text-fg-muted underline sm:min-h-0"
          >
            budgets in Admin › Settings
          </Link>
        }
      />
      {!latency ? (
        <Unavailable what="Lifecycle latency" />
      ) : states.length === 0 ? (
        <p className="m-0 px-4 text-sm text-fg-muted">Every lifecycle watch is turned off.</p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-2.5 px-4">
            {states.map((state) => (
              <LatencyRow key={`${state.entityType}.${state.status}`} state={state} />
            ))}
          </ul>
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs text-fg-muted"
            aria-hidden="true"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm" style={{ background: adminChartSeries[0] }} />{' '}
              p95 in this range
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-0.5 rounded bg-fg-primary" /> Budget
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm bg-[var(--sam-color-danger)]" /> Over budget (≥{' '}
              {latency.minSamples} episodes)
            </span>
          </div>
          <p className="m-0 px-4 text-xs text-fg-muted" data-testid="latency-sampling-note">
            Times run from the watchdog&apos;s first to last sample of a state, so they are lower
            bounds: a state seen only once reads 0s.
          </p>
          {flagged.map((state) => (
            <LatencyCallout key={`callout-${state.entityType}.${state.status}`} state={state} />
          ))}
        </>
      )}
    </Pane>
  );
}
