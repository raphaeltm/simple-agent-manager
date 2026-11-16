/**
 * Admin Health & cost sections (Insights slice H). Bars are plain HTML so they wrap and resize
 * with the pane on a phone, and every mark carries an accessible label with its numbers.
 * Layout follows the prototype (Library /product/analytics/analytics-prototypes.html?s=admin).
 */
import type {
  InstallationComputeSpend,
  InstallationLatencyState,
  InstallationLifecycleLatency,
  InstallationMachineDensity,
  InstallationMachineReuse,
  InstallationNewMachineReasons,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { adminChartSeries } from '../admin-analytics/chartTokens';
import {
  formatDuration,
  formatPercent,
  formatUsd,
  lifecycleStateLabel,
  providerLabel,
  timeLabel,
  weekLabel,
} from './format';

function PaneHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-4">
      <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{title}</h2>
      {right && <span className="text-xs text-fg-muted">{right}</span>}
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <p className="m-0 px-4 pb-4 pt-2 text-sm text-fg-muted">{what} could not be read just now.</p>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  note,
  extra,
  testId,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  extra?: ReactNode;
  testId: string;
}) {
  return (
    <Pane className="flex min-w-0 flex-col gap-1 p-4" data-testid={testId}>
      <span className="text-xs text-fg-muted">{label}</span>
      <div className="flex items-end justify-between gap-2">
        <span className="font-mono text-[26px] font-semibold leading-none text-fg-primary">
          {value}
        </span>
        {extra}
      </div>
      {note && <span className="break-words text-xs text-fg-muted">{note}</span>}
    </Pane>
  );
}

/** Reuse rate per week, oldest first; weeks with no placements leave a gap. */
export function Sparkline({ values }: { values: (number | null)[] }) {
  const points = values
    .map((value, index) =>
      value === null
        ? null
        : { x: (index / Math.max(1, values.length - 1)) * 84, y: 21 - value * 18 }
    )
    .filter((point): point is { x: number; y: number } => point !== null);
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  return (
    <svg viewBox="0 0 84 24" width="84" height="24" aria-hidden="true" className="shrink-0">
      <polyline
        points={points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
        fill="none"
        stroke="var(--sam-color-fg-muted)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last && <circle cx={last.x} cy={last.y} r="3" fill="var(--sam-color-accent-primary)" />}
    </svg>
  );
}

export function StatTiles({
  rangeText,
  compute,
  reuse,
  density,
}: {
  rangeText: string;
  compute: InstallationComputeSpend | null;
  reuse: InstallationMachineReuse | null;
  density: InstallationMachineDensity | null;
}) {
  const providerNote = compute?.byProvider
    .map((p) => `${providerLabel(p.provider)} ${formatUsd(p.usd)}`)
    .join(' · ');
  const computeNotes = [
    providerNote || (compute ? 'No priced machines ran' : 'Could not be read'),
    compute && compute.unpricedNodes > 0 ? `${compute.unpricedNodes} without a price` : null,
    compute?.truncated ? 'lower bound: machine cap reached' : null,
  ].filter(Boolean);
  return (
    <div className="grid grid-cols-1 gap-[var(--sam-space-gutter)] sm:grid-cols-3">
      <StatTile
        testId="stat-compute"
        label={`Compute · ${rangeText}`}
        value={compute ? formatUsd(compute.totalUsd) : '—'}
        note={computeNotes.join(' · ')}
      />
      <StatTile
        testId="stat-reuse"
        label="Warm machine reuse"
        value={reuse ? formatPercent(reuse.reuseRate) : '—'}
        extra={reuse && <Sparkline values={reuse.weeks.map((week) => week.reuseRate)} />}
        note={
          reuse
            ? `${reuse.onExistingMachine} of ${reuse.placements} placements on an existing machine · ${reuse.fromWarmPool} from the warm pool`
            : 'Could not be read'
        }
      />
      <StatTile
        testId="stat-density"
        label="Agents per busy machine"
        value={
          density?.agentsPerBusyMachine != null ? density.agentsPerBusyMachine.toFixed(1) : '—'
        }
        note={
          density
            ? density.machines > 0
              ? `peak ${density.peakAgentsOnOneMachine} on one machine · ${density.busyMachineHours.toLocaleString('en-US')} busy machine-hours`
              : 'No agents ran on a machine in this range'
            : 'Could not be read'
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle latency
// ---------------------------------------------------------------------------

function LatencyRow({ state }: { state: InstallationLatencyState }) {
  const label = lifecycleStateLabel(state.entityType, state.status);
  const p95 = state.p95Ms ?? 0;
  const scale = Math.max(state.budgetMs, p95) * 1.15 || 1;
  const over = state.overBudget;
  const summary =
    state.count === 0
      ? `${label}: no finished episodes, budget ${formatDuration(state.budgetMs)}`
      : `${label}: p95 ${formatDuration(state.p95Ms)}, budget ${formatDuration(state.budgetMs)}, ${state.count} episodes${over ? ', over budget' : ''}`;
  return (
    <li
      className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_5.5rem] sm:items-center sm:gap-3"
      aria-label={summary}
    >
      <span className="break-words text-[13px] text-fg-secondary">{label}</span>
      <div className="relative h-3 rounded-full bg-[var(--sam-hairline)]" aria-hidden="true">
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
        className={`text-right font-mono text-xs ${over ? 'text-danger-fg font-semibold' : 'text-fg-muted'}`}
      >
        {state.count === 0 ? 'no data' : `${formatDuration(state.p95Ms)}${over ? ' ✕' : ''}`}
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
              className="font-medium text-accent-fg underline"
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
          <Link to="/admin/settings" className="text-fg-muted underline">
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
          {flagged.map((state) => (
            <LatencyCallout key={`callout-${state.entityType}.${state.status}`} state={state} />
          ))}
        </>
      )}
    </Pane>
  );
}

// ---------------------------------------------------------------------------
// Compute spend per week
// ---------------------------------------------------------------------------

export function SpendPane({ compute }: { compute: InstallationComputeSpend | null }) {
  const providers = [
    ...new Set((compute?.weeks ?? []).flatMap((week) => week.byProvider.map((p) => p.provider))),
  ].sort();
  const color = (provider: string) =>
    adminChartSeries[Math.max(0, providers.indexOf(provider)) % adminChartSeries.length];
  const max = Math.max(0, ...(compute?.weeks ?? []).map((week) => week.totalUsd));
  return (
    <Pane className="flex min-w-0 flex-col gap-3 pb-4" data-testid="spend-pane">
      <PaneHead title="Compute spend per week" right="at each machine's recorded price" />
      {!compute ? (
        <Unavailable what="Compute spend" />
      ) : max === 0 ? (
        <p className="m-0 px-4 text-sm text-fg-muted">No priced machines ran in these weeks.</p>
      ) : (
        <>
          <ol
            className="m-0 flex h-44 list-none items-end gap-2 px-4"
            aria-label="Compute spend per week"
          >
            {compute.weeks.map((week) => {
              const detail = week.byProvider
                .map((p) => `${providerLabel(p.provider)} ${formatUsd(p.usd)}`)
                .join(', ');
              return (
                <li
                  key={week.weekStart}
                  className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                  aria-label={`Week of ${weekLabel(week.weekStart)}: ${formatUsd(week.totalUsd)}${detail ? ` (${detail})` : ''}`}
                  title={`${weekLabel(week.weekStart)}: ${formatUsd(week.totalUsd)}${detail ? ` · ${detail}` : ''}`}
                >
                  <span className="font-mono text-[11px] text-fg-muted" aria-hidden="true">
                    {week.totalUsd > 0 ? formatUsd(week.totalUsd) : ''}
                  </span>
                  <div
                    className="flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t-[4px]"
                    style={{
                      height: `${(week.totalUsd / max) * 100}%`,
                      minHeight: week.totalUsd > 0 ? 2 : 0,
                    }}
                    aria-hidden="true"
                  >
                    {week.byProvider.map((p) => (
                      <div
                        key={p.provider}
                        style={{
                          height: `${week.totalUsd > 0 ? (p.usd / week.totalUsd) * 100 : 0}%`,
                          background: color(p.provider),
                        }}
                      />
                    ))}
                  </div>
                  <span className="whitespace-nowrap text-[11px] text-fg-muted" aria-hidden="true">
                    {weekLabel(week.weekStart)}
                  </span>
                </li>
              );
            })}
          </ol>
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs text-fg-muted"
            aria-hidden="true"
          >
            {providers.map((provider) => (
              <span key={provider} className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm" style={{ background: color(provider) }} />
                {providerLabel(provider)}
              </span>
            ))}
          </div>
        </>
      )}
    </Pane>
  );
}

// ---------------------------------------------------------------------------
// Why new machines were created
// ---------------------------------------------------------------------------

export function ReasonsPane({
  newMachines,
}: {
  newMachines: InstallationNewMachineReasons | null;
}) {
  const max = Math.max(0, ...(newMachines?.reasons ?? []).map((r) => r.machines));
  return (
    <Pane className="flex min-w-0 flex-col gap-3 pb-4" data-testid="reasons-pane">
      <PaneHead
        title="Why new machines were created"
        right={
          newMachines
            ? `${newMachines.newMachines} new machines · from placement explanations`
            : undefined
        }
      />
      {!newMachines ? (
        <Unavailable what="New-machine reasons" />
      ) : newMachines.newMachines === 0 ? (
        <p className="m-0 px-4 text-sm text-fg-muted">
          No new machines were created in this range.
        </p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-2.5 px-4">
            {newMachines.reasons.map((reason) => (
              <li
                key={reason.reason}
                className="flex flex-col gap-1"
                aria-label={`${reason.reason}: ${reason.machines} machines`}
              >
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span
                    className={`min-w-0 break-words ${reason.kind === 'refused' ? 'text-fg-secondary' : 'italic text-fg-muted'}`}
                  >
                    {reason.reason}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-fg-muted">
                    {reason.machines}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[var(--sam-hairline)]" aria-hidden="true">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(reason.machines / max) * 100}%`,
                      background:
                        reason.kind === 'refused'
                          ? adminChartSeries[1]
                          : 'var(--sam-color-fg-muted)',
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="m-0 px-4 text-xs text-fg-muted">
            Each reason is the capacity check&apos;s own words for an existing machine it turned
            down. A machine is counted once under each reason it recorded.
          </p>
        </>
      )}
    </Pane>
  );
}
