/**
 * Insights · Accounts: which account carried the project's runs, and where agents stalled on a
 * usage limit. One read (`projectAccounts`), cached per project and range. A range switch keeps
 * the last numbers on screen until the new ones arrive, and a background refresh never hides them
 * (`.claude/rules/48`).
 *
 * Another member's account is described by its kind, never named: the API never sends the name.
 */
import type {
  InsightsAccountsSection,
  ProjectAccountsResponse,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { LoadError, Loading, Notice } from '../../components/page-kit/page';
import { useQueryScope } from '../../hooks/useQueryScope';
import { projectAccountsQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { AccountCard, chartSeries, RunsByAccountChart, StallList } from './accounts-parts';
import { Empty, FlowSection } from './flow-parts';
import { useInsightsRange } from './index';

const SECTION_NAMES: Record<InsightsAccountsSection, string> = {
  runs: 'runs',
  stalls: 'limit stalls',
  usage: 'usage limits',
  tokens: 'tokens and spend',
};

export function AccountsTab() {
  const { projectId } = useProjectContext();
  const range = useInsightsRange();
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectAccountsQueryOptions(queryScope, projectId, range),
    enabled: Boolean(queryScope && projectId),
  });
  const data = query.data;

  if (!data) {
    if (query.isError) {
      return (
        <LoadError
          what="account insights"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <Loading label="Loading accounts…" />;
  }
  return <AccountsBody data={data} />;
}

export function AccountsBody({ data }: { data: ProjectAccountsResponse }) {
  const accounts = useMemo(() => new Map(data.accounts.map((a) => [a.key, a])), [data.accounts]);
  const { series, colorOf } = useMemo(() => chartSeries(data), [data]);
  const until = Date.parse(data.until);
  const now = Number.isFinite(until) ? until : Date.now();
  const stalled = data.stallEpisodes.total;
  const runsFailed = data.unavailable.includes('runs');
  const stallsFailed = data.unavailable.includes('stalls');
  const tokensFailed = data.unavailable.includes('tokens');

  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="insights-accounts"
    >
      {data.unavailable.length > 0 && (
        <Notice>
          Some numbers could not be loaded:{' '}
          {data.unavailable.map((s) => SECTION_NAMES[s]).join(', ')}.
        </Notice>
      )}

      {(data.usageLimited || data.usageAdmissionLimited) && (
        <Notice>Token usage is incomplete for this range.</Notice>
      )}

      {data.accounts.length === 0 && !runsFailed ? (
        <Pane className="px-5 py-8 text-center" data-testid="insights-accounts-empty">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">No runs in this range</h2>
          <p className="m-0 mt-1 text-[13.5px] text-fg-muted">
            When agents run in this project, each account they ran on shows here with its runs,
            merges and any time it waited on a usage limit.
          </p>
        </Pane>
      ) : (
        data.accounts.length > 0 && (
          <div className="grid min-w-0 gap-[var(--sam-space-gutter)] sm:grid-cols-2 xl:grid-cols-3">
            {data.accounts.map((account) => (
              <AccountCard
                key={account.key}
                account={account}
                color={colorOf.get(account.key) ?? 'var(--sam-person-auto)'}
                now={now}
                stallsUnavailable={stallsFailed}
                usageLimited={data.usageLimited}
                tokensUnavailable={tokensFailed}
              />
            ))}
          </div>
        )
      )}

      <div className="grid min-w-0 gap-[var(--sam-space-gutter)] lg:grid-cols-2">
        <FlowSection
          title={`Runs per ${data.bucket} by account`}
          note={
            runsFailed
              ? undefined
              : `${data.totals.runs} ${data.totals.runs === 1 ? 'run' : 'runs'}`
          }
          testId="insights-section-account-runs"
        >
          {runsFailed ? (
            <Empty>Runs could not be loaded.</Empty>
          ) : (
            <RunsByAccountChart data={data} series={series} />
          )}
        </FlowSection>
        <FlowSection
          title="Stalled on a limit"
          note={
            !stallsFailed && stalled > 0
              ? `${stalled} ${stalled === 1 ? 'time' : 'times'}`
              : undefined
          }
          testId="insights-section-stalls"
        >
          {stallsFailed ? (
            <Empty>Limit stalls could not be loaded.</Empty>
          ) : (
            <StallList episodes={data.stallEpisodes} accounts={accounts} />
          )}
        </FlowSection>
      </div>

      <p className="m-0 px-1 text-[12.5px] text-fg-muted">
        Only your own accounts are named and show their current limits. Spend is shown for API keys
        only. A run through SAM’s AI proxy counts its tokens once.
      </p>
    </div>
  );
}
