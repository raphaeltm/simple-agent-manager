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
import { CircleHelp, KeyRound, PauseCircle, Server, UserRound, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { CredentialLimitChip } from '../../components/credential-limits/CredentialLimitChip';
import { Empty } from './flow-parts';
import { bucketLabel, formatDuration } from './format';

/**
 * Series colours for the chart. Green is left out (it means working or primary in SAM Glass), and
 * so is amber (waiting on you). Accounts beyond these share "Other".
 */
const SERIES_COLORS = [
  'var(--sam-admin-chart-series-2)',
  'var(--sam-admin-chart-series-3)',
  'var(--sam-admin-chart-series-9)',
  'var(--sam-admin-chart-series-6)',
  'var(--sam-admin-chart-series-12)',
] as const;
/** "Other" and runs whose account was not recorded: neutral slate, never a loud hue. */
const NEUTRAL_COLOR = 'var(--sam-person-auto)';

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

/**
 * The account's title. Another member's account is described, never named: the API sends no
 * name for it, and a teammate row ignores one if it ever did.
 */
export function accountTitle(account: InsightsAccount): string {
  if (account.name && account.owner !== 'teammate') return account.name;
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

function AccountIcon({ account, color }: { account: InsightsAccount; color: string }) {
  const Icon =
    account.owner === 'not_recorded'
      ? CircleHelp
      : account.kind === 'api_key'
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
      // The ring is the account's colour in the chart below, so a card and its bars match.
      style={{ boxShadow: `inset 0 0 0 2px ${color}` }}
    >
      <Icon size={17} strokeWidth={1.75} />
    </span>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[12px] text-fg-muted">{label}</span>
      <span className="text-[17px] font-semibold leading-tight text-fg-primary [overflow-wrap:anywhere]">
        {value}
      </span>
      {note && <span className="text-[11.5px] text-fg-muted">{note}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--sam-hairline)] pt-2">
      <span className="shrink-0 text-[13px] text-fg-muted">{label}</span>
      <span className="min-w-0 text-right text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  );
}

/** "3× · 1.9 h": each part stays whole, and a narrow card wraps between them. */
function pausedValue(account: InsightsAccount): ReactNode {
  const { episodes, totalMs } = account.stalls;
  if (episodes === 0) return 'Never';
  return (
    <>
      <span className="whitespace-nowrap">{episodes}×</span>{' '}
      <span className="whitespace-nowrap">· {formatDuration(totalMs)}</span>
    </>
  );
}

function spendText(spend: NonNullable<InsightsAccount['spend']>): string {
  if (spend.state === 'not_reported') return 'Not reported';
  const per =
    spend.perMergedPullRequestUsd === null
      ? ''
      : ` · $${spend.perMergedPullRequestUsd.toFixed(2)} per merged pull request`;
  return `$${spend.costUsd.toFixed(2)}${per}`;
}

export function AccountCard({
  account,
  color,
  now,
}: {
  account: InsightsAccount;
  color: string;
  now: number;
}) {
  const title = accountTitle(account);
  return (
    <Pane
      as="section"
      role="group"
      className="flex min-w-0 flex-col gap-3 px-4 py-3.5"
      aria-label={title}
      data-testid={`insights-account-${account.key}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AccountIcon account={account} color={color} />
        <div className="flex min-w-0 flex-col">
          <h3 className="m-0 break-words text-[14.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {title}
          </h3>
          <span className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
            {accountSubtitle(account)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.7fr)] gap-2 border-t border-[var(--sam-hairline)] pt-2.5">
        <Stat label="Runs" value={String(account.runs)} />
        <Stat label="Merged" value={String(account.merged)} />
        <Stat
          label="Limit pauses"
          value={pausedValue(account)}
          note={account.stalls.ongoing ? 'Paused now' : undefined}
        />
      </div>
      {account.spend && <Row label="Spend">{spendText(account.spend)}</Row>}
      {account.usage && (
        <Row label="Limits now">
          <CredentialLimitChip credential={account.usage} now={now} size="sm" />
        </Row>
      )}
    </Pane>
  );
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/**
 * The five busiest accounts get a colour each; the rest share "Other" (named in the legend), and
 * runs with no recorded account are neutral like it. `colorOf` gives every card its colour.
 */
export function chartSeries(data: ProjectAccountsResponse): {
  series: Series[];
  colorOf: Map<string, string>;
} {
  const colorOf = new Map<string, string>();
  const withRuns = data.accounts.filter((a) => a.runs > 0);
  const named = withRuns.filter((a) => a.owner !== 'not_recorded');
  const shown = named.slice(0, SERIES_COLORS.length);
  const rest = [
    ...named.slice(SERIES_COLORS.length),
    ...withRuns.filter((a) => a.owner === 'not_recorded'),
  ];
  const series: Series[] = shown.map((account, index) => {
    const color = SERIES_COLORS[index] ?? NEUTRAL_COLOR;
    colorOf.set(account.key, color);
    return { key: account.key, label: accountTitle(account), color, values: account.runsByBucket };
  });
  if (rest.length > 0) {
    const onlyNotRecorded = rest.length === 1 && rest[0]?.owner === 'not_recorded';
    series.push({
      key: 'other',
      label: onlyNotRecorded ? accountTitle(rest[0] as InsightsAccount) : `Other (${rest.length})`,
      color: NEUTRAL_COLOR,
      values: data.buckets.map((_, i) =>
        rest.reduce((sum, a) => sum + (a.runsByBucket[i] ?? 0), 0)
      ),
    });
  }
  return { series, colorOf };
}

export function RunsByAccountChart({
  data,
  series,
}: {
  data: ProjectAccountsResponse;
  series: Series[];
}) {
  const totals = data.buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const dense = data.buckets.length > 8;
  if (totals.every((total) => total === 0)) {
    return <Empty>No runs in this range.</Empty>;
  }
  const peak = totals.reduce((best, total, i) => (total > (totals[best] ?? 0) ? i : best), 0);
  const perSeries = series
    .map((s) => `${s.label} ${s.values.reduce((a, b) => a + b, 0)}`)
    .join(', ');
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-accounts-chart">
      <div
        role="img"
        aria-label={`Runs per ${data.bucket} by account. ${perSeries}. Busiest ${bucketLabel(data.buckets[peak] ?? '', data.bucket)} with ${totals[peak] ?? 0}.`}
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
              {series.map((s) => {
                const value = s.values[i] ?? 0;
                if (value === 0) return null;
                return (
                  <div
                    key={s.key}
                    title={`${s.label}: ${value}`}
                    // A single run stays visible on a tall chart.
                    className="min-h-[2px]"
                    style={{ height: `${(value / max) * 100}%`, background: s.color }}
                  />
                );
              })}
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
      <p className="m-0 text-[12.5px] text-fg-muted">
        Busiest {bucketLabel(data.buckets[peak] ?? '', data.bucket)} with {totals[peak] ?? 0}
      </p>
      <ul className="m-0 flex min-w-0 list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {series.map((s) => (
          <li
            key={s.key}
            className="flex min-w-0 max-w-full items-start gap-1.5 text-[12.5px] text-fg-muted"
          >
            <span
              aria-hidden="true"
              className="mt-[3px] size-2.5 shrink-0 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const OUTCOME_TEXT: Record<InsightsStallEpisode['outcome'], string> = {
  resumed: 'resumed',
  ended: 'the run ended while it waited',
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
        {episodes.items.map((episode, index) => {
          const account = accounts.get(episode.accountKey);
          const name = account ? accountTitle(account) : 'Account not recorded';
          const runs =
            episode.runs === 0
              ? 'Reported by the provider'
              : `${episode.runs} ${episode.runs === 1 ? 'run' : 'runs'} paused`;
          return (
            <li
              key={`${episode.accountKey}-${episode.startedAt}-${index}`}
              className="flex min-w-0 items-start gap-3 border-t border-[var(--sam-hairline)] py-2.5 first:border-t-0 first:pt-0"
            >
              <PauseCircle
                size={17}
                strokeWidth={1.75}
                aria-hidden="true"
                className={
                  // Amber means waiting on you: only a stall that needs a person.
                  episode.outcome === 'blocked'
                    ? 'mt-0.5 shrink-0 text-[var(--sam-color-warning-fg)]'
                    : episode.outcome === 'ongoing'
                      ? 'mt-0.5 shrink-0 text-fg-primary'
                      : 'mt-0.5 shrink-0 text-fg-muted'
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
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
                <span className="sr-only">Paused for </span>
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
