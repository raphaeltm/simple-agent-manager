/**
 * Cloudflare card on Admin Health & cost (Insights slice CF): the stored daily snapshot of the
 * Cloudflare account's usage-derived cost. Month to date, the projection for the month (spent so
 * far plus the recent daily rate), the top product lines and a small daily series. Always labelled
 * an estimate: it is not an invoice. Layout follows the prototype
 * (Library /product/analytics/analytics-prototypes.html?s=admin).
 */
import {
  CLOUDFLARE_PRICES_CHECKED_ON,
  type InstallationCloudflareCost,
} from '@simple-agent-manager/shared';
import { Button, Pane } from '@simple-agent-manager/ui';

import { adminChartSeries } from '../admin-analytics/chartTokens';
import { dayLabel, formatMoney, monthName, timeLabel } from './format';
import { PaneHead, Unavailable } from './pane-parts';

const usd = (amount: number) => formatMoney(amount, 'USD');

/** Value and note for the Cloudflare stat tile. */
export function cloudflareTileText(cloudflare: InstallationCloudflareCost | null): {
  value: string;
  note: string;
} {
  if (!cloudflare) return { value: '—', note: 'Could not be read' };
  if (!cloudflare.month) {
    const notes: Record<InstallationCloudflareCost['status'], string> = {
      never_run: 'First snapshot runs daily',
      not_configured: 'Not set up: see the Cloudflare card',
      permission_denied: 'Token cannot read account analytics',
      error: 'Last snapshot failed',
      ok: 'No days stored yet',
    };
    return { value: '—', note: notes[cloudflare.status] };
  }
  const month = monthName(cloudflare.month);
  return {
    value: usd(cloudflare.monthToDateUsd),
    note: cloudflare.monthComplete
      ? `${month} total, estimated`
      : `${month} so far · projected ${usd(cloudflare.projectedUsd)}`,
  };
}

function StatusNotice({ cloudflare }: { cloudflare: InstallationCloudflareCost }) {
  const attempted = cloudflare.lastAttemptAt ? ` (${timeLabel(cloudflare.lastAttemptAt)})` : '';
  let text: string | null = null;
  if (cloudflare.status === 'not_configured')
    text =
      'Cloudflare cost is not set up. The Worker needs the CF_API_TOKEN and CF_ACCOUNT_ID secrets (deploys set them from the GitHub Environment), and the token needs Account → Account Analytics → Read. Then press Refresh now.';
  else if (cloudflare.status === 'permission_denied')
    text = `The Cloudflare token cannot read account analytics${attempted}. Add Account → Account Analytics → Read to the token in CF_API_TOKEN in the Cloudflare dashboard, then press Refresh now.`;
  else if (cloudflare.status === 'error')
    text = `The last snapshot failed${attempted}: ${cloudflare.error ?? 'unknown error'}.${cloudflare.month ? ' Earlier days still show.' : ''}`;
  else if (cloudflare.status === 'never_run')
    text = 'No snapshot yet. It runs daily, or press Refresh now.';
  if (!text) return null;
  const failed = cloudflare.status === 'error' || cloudflare.status === 'permission_denied';
  const lead =
    cloudflare.status === 'never_run'
      ? 'Not fetched yet.'
      : failed
        ? 'Needs attention.'
        : 'Needs setup.';
  return (
    <p
      className={`m-0 break-words px-4 text-sm ${failed ? 'text-danger-fg' : 'text-fg-secondary'}`}
      role="status"
      data-testid="cloudflare-status"
    >
      <strong className="font-semibold">{lead}</strong> {text}
    </p>
  );
}

function DailySeries({ daily }: { daily: InstallationCloudflareCost['daily'] }) {
  const max = Math.max(0, ...daily.map((entry) => entry.costUsd ?? 0));
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (!first || !last) return null;
  const amount = (entry: (typeof daily)[number]) =>
    entry.costUsd === null ? 'no data' : usd(entry.costUsd);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4" data-testid="cloudflare-daily">
      <div className="flex justify-between gap-2 text-xs text-fg-muted">
        <span>Estimated cost per day</span>
        <span>peak {usd(max)}</span>
      </div>
      {/* The bars are a picture of the table below, which carries every value for touch,
          keyboard and screen-reader users. */}
      <ol className="m-0 flex h-16 list-none items-end gap-px p-0" aria-hidden="true">
        {daily.map((entry) => (
          <li
            key={entry.day}
            className="flex h-full min-w-0 flex-1 items-end"
            title={`${dayLabel(entry.day)}: ${amount(entry)}`}
          >
            {entry.costUsd === null ? (
              // A day with no data is a dashed stub, so it never reads as a $0 day.
              <div className="h-1 w-full border-0 border-t border-dashed border-[var(--sam-color-fg-muted)]" />
            ) : (
              <div
                className="w-full rounded-t-sm"
                style={{
                  height: `${max > 0 ? (entry.costUsd / max) * 100 : 0}%`,
                  minHeight: entry.costUsd > 0 ? 2 : 0,
                  background: adminChartSeries[0],
                }}
              />
            )}
          </li>
        ))}
      </ol>
      <div className="flex justify-between text-xs text-fg-muted" aria-hidden="true">
        <span>{dayLabel(first.day)}</span>
        <span>{dayLabel(last.day)}</span>
      </div>
      <details className="text-xs text-fg-muted" data-testid="cloudflare-daily-table">
        <summary className="inline-flex min-h-11 cursor-pointer items-center sm:min-h-0">
          Show days as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[12rem] text-left">
            <thead>
              <tr>
                <th className="py-1 pr-3 font-medium">Day</th>
                <th className="py-1 font-medium">Estimated cost</th>
              </tr>
            </thead>
            <tbody className="font-mono text-fg-secondary">
              {daily.map((entry) => (
                <tr
                  key={entry.day}
                  className="border-0 border-t border-solid border-[var(--sam-hairline)]"
                >
                  <td className="py-1 pr-3 font-sans">{dayLabel(entry.day)}</td>
                  <td className="py-1">{amount(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function RefreshRow({
  cloudflare,
  onRefresh,
  refreshing,
}: {
  cloudflare: InstallationCloudflareCost;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4">
      <span className="text-xs text-fg-muted">
        {cloudflare.lastSuccessAt
          ? `Updated ${timeLabel(cloudflare.lastSuccessAt)}`
          : 'Not updated yet'}
      </span>
      <Button
        variant="secondary"
        size="md"
        onClick={onRefresh}
        loading={refreshing}
        data-testid="cloudflare-refresh"
      >
        Refresh now
      </Button>
    </div>
  );
}

export function CloudflarePane({
  cloudflare,
  onRefresh,
  refreshing,
}: {
  cloudflare: InstallationCloudflareCost | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const month = cloudflare?.month ? monthName(cloudflare.month) : null;
  const max = Math.max(0, ...(cloudflare?.productLines ?? []).map((line) => line.projectedUsd));
  return (
    <Pane className="flex min-w-0 flex-col gap-3 pb-4" data-testid="cloudflare-pane">
      <PaneHead title="Cloudflare" right="estimate from usage · whole account" />
      {!cloudflare ? (
        <Unavailable what="Cloudflare cost" />
      ) : (
        <>
          <StatusNotice cloudflare={cloudflare} />
          {!cloudflare.month && (
            <RefreshRow cloudflare={cloudflare} onRefresh={onRefresh} refreshing={refreshing} />
          )}
          {cloudflare.month && (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4">
                <span className="font-mono text-2xl font-semibold text-fg-primary">
                  {usd(cloudflare.monthToDateUsd)}
                </span>
                <span className="text-sm text-fg-muted">
                  {cloudflare.monthComplete
                    ? `${month} total`
                    : `${month} through ${dayLabel(cloudflare.throughDay ?? '')} · projected ${usd(cloudflare.projectedUsd)} for ${month}`}
                </span>
              </div>
              {cloudflare.missingDays > 0 && (
                <p className="m-0 px-4 text-xs text-fg-muted" data-testid="cloudflare-missing">
                  {cloudflare.missingDays} {cloudflare.missingDays === 1 ? 'day' : 'days'} of{' '}
                  {month} have no data and count as $0.
                </p>
              )}
              {!cloudflare.monthComplete && (
                <p className="m-0 px-4 text-xs text-fg-muted">
                  Each line: so far → projected for {month}. The solid bar is spent so far.
                </p>
              )}
              <ul className="m-0 flex list-none flex-col gap-2.5 px-4">
                {cloudflare.productLines.map((line) => (
                  <li key={line.key} className="flex flex-col gap-1" data-testid="cloudflare-line">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words text-fg-secondary">{line.label}</span>
                      <span className="shrink-0 font-mono text-xs text-fg-muted">
                        <span className="sr-only">so far </span>
                        {usd(line.monthToDateUsd)}
                        {!cloudflare.monthComplete && (
                          <>
                            <span aria-hidden="true"> → </span>
                            <span className="sr-only">, projected </span>
                            {usd(line.projectedUsd)}
                          </>
                        )}
                      </span>
                    </div>
                    {/* Spent so far solid, the rest of the projection faint, on one scale. */}
                    <div
                      className="flex h-2 overflow-hidden rounded-full bg-[var(--sam-hairline)]"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${max > 0 ? (line.monthToDateUsd / max) * 100 : 0}%`,
                          background: adminChartSeries[0],
                        }}
                      />
                      <div
                        className="h-full opacity-40"
                        style={{
                          width: `${max > 0 ? (Math.max(0, line.projectedUsd - line.monthToDateUsd) / max) * 100 : 0}%`,
                          background: adminChartSeries[0],
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              {cloudflare.otherProductLines.count > 0 && (
                <p className="m-0 px-4 text-xs text-fg-muted" data-testid="cloudflare-other">
                  Everything else ({cloudflare.otherProductLines.count} lines):{' '}
                  {usd(cloudflare.otherProductLines.monthToDateUsd)}
                  {!cloudflare.monthComplete && (
                    <>
                      <span aria-hidden="true"> → </span>
                      <span className="sr-only">, projected </span>
                      {usd(cloudflare.otherProductLines.projectedUsd)}
                    </>
                  )}
                </p>
              )}
              <DailySeries daily={cloudflare.daily} />
            </>
          )}
          {cloudflare.month && (
            <RefreshRow cloudflare={cloudflare} onRefresh={onRefresh} refreshing={refreshing} />
          )}
          <p className="m-0 px-4 text-xs text-fg-muted">
            An estimate from Cloudflare&apos;s billed usage analytics at list prices (checked{' '}
            {CLOUDFLARE_PRICES_CHECKED_ON}), not an invoice. It covers every Worker on this
            Cloudflare account and leaves out the Workers Paid subscription, R2 operations and
            container CPU and disk. Kept apart from compute spend.
          </p>
        </>
      )}
    </Pane>
  );
}
