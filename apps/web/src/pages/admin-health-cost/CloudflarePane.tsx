/**
 * Cloudflare card on Admin Health & cost (Insights slice CF): the stored daily snapshot of the
 * Cloudflare account's usage-derived cost. Month to date, the projection for the month (spent so
 * far plus the recent daily rate), the top product lines and a small daily series. Always labelled
 * an estimate: it is not an invoice. Layout follows the prototype
 * (Library /product/analytics/analytics-prototypes.html?s=admin).
 */
import type { InstallationCloudflareCost } from '@simple-agent-manager/shared';
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
      never_run: 'First snapshot runs daily at 03:00 UTC',
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
    text = 'No snapshot yet. It runs daily at 03:00 UTC, or press Refresh now.';
  if (!text) return null;
  return (
    <p
      className="m-0 break-words px-4 text-sm text-fg-muted"
      role="status"
      data-testid="cloudflare-status"
    >
      {text}
    </p>
  );
}

function DailySeries({ daily }: { daily: InstallationCloudflareCost['daily'] }) {
  const max = Math.max(0, ...daily.map((entry) => entry.costUsd ?? 0));
  const first = daily[0];
  const last = daily[daily.length - 1];
  if (!first || !last) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4" data-testid="cloudflare-daily">
      <ol
        className="m-0 flex h-16 list-none items-end gap-px p-0"
        aria-label="Estimated Cloudflare cost per day"
      >
        {daily.map((entry) => (
          <li
            key={entry.day}
            className="flex h-full min-w-0 flex-1 items-end"
            aria-label={`${dayLabel(entry.day)}: ${entry.costUsd === null ? 'no data' : usd(entry.costUsd)}`}
            title={`${dayLabel(entry.day)}: ${entry.costUsd === null ? 'no data' : usd(entry.costUsd)}`}
          >
            <div
              className="w-full rounded-t-[2px]"
              style={{
                height: `${max > 0 && entry.costUsd ? (entry.costUsd / max) * 100 : 0}%`,
                minHeight: entry.costUsd ? 2 : 0,
                background: adminChartSeries[0],
              }}
            />
          </li>
        ))}
      </ol>
      <div className="flex justify-between text-[11px] text-fg-muted" aria-hidden="true">
        <span>{dayLabel(first.day)}</span>
        <span>{dayLabel(last.day)}</span>
      </div>
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
          {cloudflare.month && (
            <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4">
                <span className="font-mono text-[22px] font-semibold text-fg-primary">
                  {usd(cloudflare.monthToDateUsd)}
                </span>
                <span className="text-[13px] text-fg-muted">
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
              <ul className="m-0 flex list-none flex-col gap-2.5 px-4">
                {cloudflare.productLines.map((line) => (
                  <li key={line.key} className="flex flex-col gap-1" data-testid="cloudflare-line">
                    <div className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="min-w-0 break-words text-fg-secondary">{line.label}</span>
                      <span className="shrink-0 font-mono text-xs text-fg-muted">
                        {usd(line.monthToDateUsd)}
                        {!cloudflare.monthComplete && (
                          <span className="text-fg-muted"> → {usd(line.projectedUsd)}</span>
                        )}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--sam-hairline)]" aria-hidden="true">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${max > 0 ? (line.projectedUsd / max) * 100 : 0}%`,
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
                  {!cloudflare.monthComplete &&
                    ` → ${usd(cloudflare.otherProductLines.projectedUsd)}`}
                </p>
              )}
              <DailySeries daily={cloudflare.daily} />
            </>
          )}
          <p className="m-0 px-4 text-xs text-fg-muted">
            An estimate from Cloudflare&apos;s billed usage analytics at list prices, not an
            invoice. It covers every Worker on this Cloudflare account and leaves out the Workers
            Paid subscription, R2 operations and container CPU and disk. Kept apart from compute
            spend.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4">
            <span className="text-xs text-fg-muted">
              {cloudflare.lastSuccessAt
                ? `Updated ${timeLabel(cloudflare.lastSuccessAt)}`
                : 'Not updated yet'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={onRefresh}
              loading={refreshing}
              disabled={refreshing}
              data-testid="cloudflare-refresh"
              className="max-sm:min-h-11"
            >
              Refresh now
            </Button>
          </div>
        </>
      )}
    </Pane>
  );
}
