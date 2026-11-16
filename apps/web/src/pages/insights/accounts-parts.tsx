/**
 * The Accounts tab's parts: one card per account, runs per day or week stacked by account, and
 * the list of limit stalls. Charts are plain HTML bars like Flow's, with a text equivalent.
 */
import {
  getAgentDefinition,
  type InsightsAccount,
  type InsightsStallEpisode,
  isValidAgentType,
  type ProjectAccountsResponse,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { Gauge, KeyRound, PauseCircle, Server, UserRound, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { CredentialLimitChip } from '../../components/credential-limits/CredentialLimitChip';
import { Empty } from './flow-parts';
import { bucketLabel, formatDuration } from './format';

/** Series colours for the chart; amber is left out (it means "waiting on you" in SAM Glass). */
const SERIES_COLORS = [
  'var(--sam-admin-chart-series-1)',
  'var(--sam-admin-chart-series-2)',
  'var(--sam-admin-chart-series-3)',
  'var(--sam-admin-chart-series-7)',
  'var(--sam-admin-chart-series-6)',
] as const;
const OTHER_COLOR = 'var(--sam-color-fg-muted)';

const KIND_LABELS: Record<InsightsAccount['kind'], string> = {
  subscription: 'Subscription',
  api_key: 'API key · pay as you go',
  platform: 'SAM platform credential',
  unknown: 'Kind not recorded',
};

function agentLabel(agentType: string | null): string | null {
  if (!agentType) return null;
  return isValidAgentType(agentType)
    ? (getAgentDefinition(agentType)?.name ?? agentType)
    : agentType;
}

/** The account's title. Another member's account is described, never named. */
export function accountTitle(account: InsightsAccount): string {
  if (account.name) return account.name;
  const many = account.credentials > 1;
  switch (account.owner) {
    case 'teammate':
      return many ? `Teammates’ accounts (${account.credentials})` : 'A teammate’s account';
    case 'project':
      return many ? `Project accounts (${account.credentials})` : 'Project account';
    case 'platform':
      return 'SAM platform';
    case 'not_recorded':
      return 'Account not recorded';
    case 'you':
      return 'Your account (removed)';
  }
}

function accountSubtitle(account: InsightsAccount): string {
  if (account.owner === 'not_recorded') return 'Runs whose agent session recorded no credential';
  return [KIND_LABELS[account.kind], agentLabel(account.agentType)].filter(Boolean).join(' · ');
}

function AccountIcon({ account }: { account: InsightsAccount }) {
  const Icon =
    account.kind === 'api_key'
      ? KeyRound
      : account.owner === 'platform'
        ? Server
        : account.owner === 'teammate' || account.owner === 'project'
          ? UsersRound
          : UserRound;
  return (
    <span
      aria-hidden="true"
      className="sam-raised grid size-9 shrink-0 place-items-center rounded-full text-fg-muted"
    >
      <Icon size={17} strokeWidth={1.75} />
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-t border-[var(--sam-hairline)] pt-2">
      <span className="shrink-0 text-[13px] text-fg-muted">{label}</span>
      <span className="min-w-0 text-right text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  );
}

function stallText(account: InsightsAccount): string {
  const { episodes, totalMs } = account.stalls;
  if (episodes === 0) return 'Never';
  return `${episodes}× · ${formatDuration(totalMs)}${account.stalls.ongoing ? ' · paused now' : ''}`;
}

export function AccountCard({
  account,
  rangeText,
  now,
}: {
  account: InsightsAccount;
  rangeText: string;
  now: number;
}) {
  const title = accountTitle(account);
  return (
    <Pane
      className="flex min-w-0 flex-col gap-2.5 px-4 py-3.5"
      aria-label={title}
      data-testid={`insights-account-${account.key}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AccountIcon account={account} />
        <div className="flex min-w-0 flex-col">
          <span
            className="line-clamp-3 break-words text-[14.5px] font-semibold text-fg-primary"
            title={title}
          >
            {title}
          </span>
          <span className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
            {accountSubtitle(account)}
          </span>
        </div>
      </div>
      <Row label={`Runs, ${rangeText}`}>{account.runs}</Row>
      <Row label="Merged a pull request">{account.merged}</Row>
      <Row label="Paused for limits">{stallText(account)}</Row>
      {account.spend && (
        <>
          <Row label="Spent">
            {account.spend.state === 'reported'
              ? `$${account.spend.costUsd.toFixed(2)}`
              : 'Not reported'}
          </Row>
          <Row label="Per merged pull request">
            {account.spend.state === 'reported' && account.spend.perMergedPullRequestUsd !== null
              ? `$${account.spend.perMergedPullRequestUsd.toFixed(2)}`
              : 'Not reported'}
          </Row>
        </>
      )}
      {account.usage && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--sam-hairline)] pt-2">
          <span className="flex items-center gap-1.5 text-[13px] text-fg-muted">
            <Gauge size={14} strokeWidth={1.75} aria-hidden="true" />
            Limits now
          </span>
          <CredentialLimitChip credential={account.usage} now={now} size="sm" />
        </div>
      )}
    </Pane>
  );
}

interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/** The five busiest accounts get a colour each; the rest share "Other" (named in the legend). */
export function chartSeries(data: ProjectAccountsResponse): { series: Series[]; others: number } {
  const withRuns = data.accounts.filter((a) => a.runs > 0);
  const shown = withRuns.slice(0, SERIES_COLORS.length);
  const rest = withRuns.slice(SERIES_COLORS.length);
  const series: Series[] = shown.map((account, index) => ({
    key: account.key,
    label: accountTitle(account),
    color: SERIES_COLORS[index] ?? OTHER_COLOR,
    values: account.runsByBucket,
  }));
  if (rest.length > 0) {
    series.push({
      key: 'other',
      label: `Other (${rest.length})`,
      color: OTHER_COLOR,
      values: data.buckets.map((_, i) =>
        rest.reduce((sum, a) => sum + (a.runsByBucket[i] ?? 0), 0)
      ),
    });
  }
  return { series, others: rest.length };
}

export function RunsByAccountChart({ data }: { data: ProjectAccountsResponse }) {
  const { series } = chartSeries(data);
  const totals = data.buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const dense = data.buckets.length > 8;
  if (totals.every((total) => total === 0)) {
    return <Empty>No runs in this range.</Empty>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-accounts-chart">
      <div
        role="img"
        aria-label={`Runs per ${data.bucket} by account: ${data.buckets
          .map(
            (start, i) =>
              `${bucketLabel(start, data.bucket)} ${
                series
                  .filter((s) => (s.values[i] ?? 0) > 0)
                  .map((s) => `${s.label} ${s.values[i]}`)
                  .join(', ') || 'none'
              }`
          )
          .join('; ')}`}
        className="flex h-[150px] min-w-0 items-end gap-1 sm:gap-1.5"
      >
        {data.buckets.map((start, i) => (
          <div key={start} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
            <span
              className={`font-mono text-[11px] text-fg-muted ${dense ? 'max-sm:invisible' : ''}`}
            >
              {totals[i] || ''}
            </span>
            <div
              className="flex w-full max-w-[36px] flex-1 flex-col-reverse overflow-hidden rounded-[5px]"
              data-intentional-clip="rounded bar ends"
            >
              {series.map((s) => (
                <div
                  key={s.key}
                  style={{ height: `${((s.values[i] ?? 0) / max) * 100}%`, background: s.color }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex min-w-0 gap-1 sm:gap-1.5" aria-hidden="true">
        {data.buckets.map((start, index) => (
          <span
            key={start}
            className={`min-w-0 flex-1 whitespace-nowrap text-center font-mono text-[10.5px] text-fg-muted ${dense && index % 2 === 1 ? 'max-sm:invisible' : ''}`}
          >
            {bucketLabel(start, data.bucket)}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span
            key={s.key}
            className="flex min-w-0 max-w-full items-center gap-1.5 text-[12.5px] text-fg-muted"
            title={s.label}
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="line-clamp-1 min-w-0 break-words">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const OUTCOME_TEXT: Record<InsightsStallEpisode['outcome'], string> = {
  resumed: 'resumed',
  blocked: 'stopped retrying, needs a person',
  ongoing: 'still waiting',
};

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function StallList({
  episodes,
  accounts,
}: {
  episodes: ProjectAccountsResponse['stallEpisodes'];
  accounts: ReadonlyMap<string, InsightsAccount>;
}) {
  if (episodes.items.length === 0) {
    return <Empty>No agent waited on a usage limit in this range.</Empty>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="m-0 flex list-none flex-col p-0" data-testid="insights-stall-list">
        {episodes.items.map((episode) => {
          const account = accounts.get(episode.accountKey);
          const name = account ? accountTitle(account) : 'Account not recorded';
          const runs =
            episode.runs === 0
              ? 'Reported by the provider'
              : `${episode.runs} ${episode.runs === 1 ? 'run' : 'runs'} paused`;
          return (
            <li
              key={`${episode.accountKey}-${episode.startedAt}`}
              className="flex min-w-0 items-start gap-3 border-t border-[var(--sam-hairline)] py-2.5 first:border-t-0 first:pt-0"
            >
              <PauseCircle
                size={17}
                strokeWidth={1.75}
                aria-hidden="true"
                className={
                  episode.outcome === 'resumed'
                    ? 'mt-0.5 shrink-0 text-fg-muted'
                    : 'mt-0.5 shrink-0 text-[var(--sam-color-warning-fg)]'
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className="line-clamp-2 break-words text-[13.5px] font-semibold text-fg-primary"
                  title={name}
                >
                  {name}
                </span>
                <span className="text-[12.5px] text-fg-muted">
                  {when(episode.startedAt)}
                  {episode.window ? ` · ${episode.window} window` : ''}
                </span>
                <span className="text-[12.5px] text-fg-muted">
                  {runs} · {OUTCOME_TEXT[episode.outcome]}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[12.5px] text-fg-muted">
                {formatDuration(episode.durationMs)}
              </span>
            </li>
          );
        })}
      </ul>
      {(episodes.total > episodes.items.length || episodes.truncated) && (
        <p className="m-0 text-[12.5px] text-fg-muted">
          {episodes.total > episodes.items.length
            ? `Showing the ${episodes.items.length} most recent of ${episodes.total}.`
            : ''}
          {episodes.truncated ? ' Older limit waits were not examined.' : ''}
        </p>
      )}
    </div>
  );
}
