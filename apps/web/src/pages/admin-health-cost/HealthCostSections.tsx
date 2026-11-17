/**
 * Admin Health & cost sections (Insights slice H). Bars are plain HTML so they wrap and resize
 * with the pane on a phone, and every mark carries an accessible label with its numbers.
 * Layout follows the prototype (Library /product/analytics/analytics-prototypes.html?s=admin).
 */
import type {
  InstallationComputeCurrencySpend,
  InstallationComputeSpend,
  InstallationMachineDensity,
  InstallationMachineReuse,
  InstallationNewMachineReasons,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';

import { adminChartSeries } from '../admin-analytics/chartTokens';
import { formatMoney, formatPercent, providerLabel, weekLabel } from './format';
import { PaneHead, Unavailable } from './pane-parts';

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
  // Currencies are never added together: SAM keeps no exchange rates.
  const currencies = compute?.currencies ?? [];
  const totalText = currencies.length
    ? currencies.map((c) => formatMoney(c.total, c.currency)).join(' · ')
    : formatMoney(0, 'USD');
  const providerNote = currencies
    .flatMap((c) =>
      c.byProvider.map((p) => `${providerLabel(p.provider)} ${formatMoney(p.amount, c.currency)}`)
    )
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
        value={compute ? totalText : '—'}
        note={computeNotes.join(' · ')}
      />
      <StatTile
        testId="stat-reuse"
        label="Warm machine reuse"
        value={reuse ? formatPercent(reuse.reuseRate) : '—'}
        extra={reuse && <Sparkline values={reuse.weeks.map((week) => week.reuseRate)} />}
        note={
          reuse
            ? `${reuse.onExistingMachine} of ${reuse.placements} placements on an existing machine${reuse.fromWarmPool === null ? '' : ` · ${reuse.fromWarmPool} from the warm pool`}`
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
// Compute spend per week
// ---------------------------------------------------------------------------

export function SpendPane({ compute }: { compute: InstallationComputeSpend | null }) {
  const charted = (compute?.currencies ?? []).filter((spend) =>
    spend.weeks.some((week) => week.total > 0)
  );
  // One colour per provider across every chart, so a colour never names two providers.
  const providers = [
    ...new Set(
      charted.flatMap((spend) =>
        spend.weeks.flatMap((week) => week.byProvider.map((p) => p.provider))
      )
    ),
  ].sort((a, b) => a.localeCompare(b));
  const color = (provider: string) =>
    adminChartSeries[Math.max(0, providers.indexOf(provider)) % adminChartSeries.length];
  return (
    <Pane className="flex min-w-0 flex-col gap-3 pb-4" data-testid="spend-pane">
      <PaneHead title="Compute spend per week" right="at each machine's recorded price" />
      {!compute ? (
        <Unavailable what="Compute spend" />
      ) : charted.length === 0 ? (
        <p className="m-0 px-4 text-sm text-fg-muted">No priced machines ran in these weeks.</p>
      ) : (
        // One chart per price currency: amounts in different currencies are never stacked.
        charted.map((spend) => (
          <SpendChart
            key={spend.currency}
            spend={spend}
            labelled={charted.length > 1}
            color={color}
          />
        ))
      )}
    </Pane>
  );
}

function SpendChart({
  spend,
  labelled,
  color,
}: {
  spend: InstallationComputeCurrencySpend;
  labelled: boolean;
  color: (provider: string) => string | undefined;
}) {
  const money = (amount: number) => formatMoney(amount, spend.currency);
  const providers = [
    ...new Set(spend.weeks.flatMap((week) => week.byProvider.map((p) => p.provider))),
  ].sort((a, b) => a.localeCompare(b));
  const max = Math.max(0, ...spend.weeks.map((week) => week.total));
  const weekCount = spend.weeks.length;
  const lastIndex = weekCount - 1;
  // At most about six week labels, so 26 weeks stay legible on a phone.
  const labelStep = Math.max(1, Math.ceil(weekCount / 6));
  return (
    <div
      className="flex min-w-0 flex-col gap-3 [&+&]:border-0 [&+&]:border-t [&+&]:border-solid [&+&]:border-[var(--sam-hairline)] [&+&]:pt-3"
      data-testid={`spend-chart-${spend.currency}`}
    >
      {labelled && (
        <h3 className="m-0 px-4 text-[13px] font-semibold text-fg-secondary">
          Priced in {spend.currency}
        </h3>
      )}
      <ol
        className="m-0 flex h-44 list-none items-end gap-2 px-4"
        aria-label={`Compute spend per week in ${spend.currency}`}
      >
        {spend.weeks.map((week, index) => {
          const detail = week.byProvider
            .map((p) => `${providerLabel(p.provider)} ${money(p.amount)}`)
            .join(', ');
          // On a phone the end columns are narrower than their labels: keep them inside the pane.
          const edge =
            index === lastIndex ? 'max-sm:self-end' : index === 0 ? 'max-sm:self-start' : '';
          return (
            <li
              key={week.weekStart}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              aria-label={`Week of ${weekLabel(week.weekStart)}: ${money(week.total)}${detail ? ` (${detail})` : ''}`}
              title={`${weekLabel(week.weekStart)}: ${money(week.total)}${detail ? ` · ${detail}` : ''}`}
            >
              {/* Only the latest week carries its value; the rest are in each label. */}
              <span
                className={`whitespace-nowrap font-mono text-[11px] text-fg-muted ${edge}`}
                aria-hidden="true"
              >
                {index === lastIndex && week.total > 0 ? money(week.total) : ' '}
              </span>
              <div
                className="flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t-[4px]"
                style={{
                  height: `${max > 0 ? (week.total / max) * 100 : 0}%`,
                  minHeight: week.total > 0 ? 2 : 0,
                }}
                aria-hidden="true"
              >
                {week.byProvider.map((p) => (
                  <div
                    key={p.provider}
                    style={{
                      height: `${week.total > 0 ? (p.amount / week.total) * 100 : 0}%`,
                      background: color(p.provider),
                    }}
                  />
                ))}
              </div>
              <span
                className={`whitespace-nowrap text-[11px] text-fg-muted ${edge}`}
                aria-hidden="true"
              >
                {/* Every `labelStep` weeks and always the latest, skipping a label that would
                    sit right next to the latest one. */}
                {(index % labelStep === 0 && lastIndex - index >= labelStep) || index === lastIndex
                  ? weekLabel(week.weekStart)
                  : ' '}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs text-fg-muted" aria-hidden="true">
        {providers.map((provider) => (
          <span key={provider} className="flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-sm" style={{ background: color(provider) }} />
            {providerLabel(provider)}
          </span>
        ))}
      </div>
      {/* Every week's numbers, for touch and keyboard readers the hover title does not reach. */}
      <details className="px-4 text-xs text-fg-muted" data-testid={`spend-table-${spend.currency}`}>
        <summary className="inline-flex min-h-11 cursor-pointer items-center sm:min-h-0">
          Show weeks as a table{labelled ? ` (${spend.currency})` : ''}
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[16rem] text-left">
            <thead>
              <tr className="text-fg-muted">
                <th className="py-1 pr-3 font-medium">Week of</th>
                <th className="py-1 pr-3 font-medium">Total</th>
                <th className="py-1 font-medium">By provider</th>
              </tr>
            </thead>
            <tbody className="font-mono text-fg-secondary">
              {spend.weeks.map((week) => (
                <tr
                  key={week.weekStart}
                  className="border-0 border-t border-solid border-[var(--sam-hairline)]"
                >
                  <td className="py-1 pr-3 font-sans">{weekLabel(week.weekStart)}</td>
                  <td className="py-1 pr-3">{money(week.total)}</td>
                  <td className="py-1 font-sans">
                    {week.byProvider
                      .map((p) => `${providerLabel(p.provider)} ${money(p.amount)}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
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
              <li key={reason.reason} className="flex flex-col gap-1" data-testid="reason-row">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span
                    className={`min-w-0 break-words ${reason.kind === 'refused' ? 'text-fg-secondary' : 'italic text-fg-muted'}`}
                  >
                    {reason.reason}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-fg-muted">
                    {reason.machines}
                    <span className="sr-only">
                      {' '}
                      {reason.machines === 1 ? 'machine' : 'machines'}
                    </span>
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
          {newMachines.otherReasons > 0 && (
            <p className="m-0 px-4 text-xs text-fg-muted" data-testid="other-reasons">
              {newMachines.otherReasons} less common{' '}
              {newMachines.otherReasons === 1 ? 'reason' : 'reasons'} not listed.
            </p>
          )}
          <p className="m-0 px-4 text-xs text-fg-muted">
            Each reason is the capacity check&apos;s own words for an existing machine it turned
            down. A machine is counted once under each reason it recorded.
          </p>
        </>
      )}
    </Pane>
  );
}
