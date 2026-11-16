/**
 * Insights · Flow: how work moves from idea to merged. One read (`projectFlow`), cached per
 * project and range. A range switch keeps the last numbers on screen until the new ones arrive,
 * and a background refresh never hides them (`.claude/rules/48`).
 */
import type {
  FlowSection as FlowSectionName,
  ProjectFlowResponse,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';

import { LoadError, Loading, Notice } from '../../components/page-kit/page';
import { useQueryScope } from '../../hooks/useQueryScope';
import { projectFlowQueryOptions } from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import {
  Empty,
  FlakyChecks,
  FlowSection,
  RunsChart,
  StopReasons,
  Tile,
  WaitingIdeas,
} from './flow-parts';
import { durationDelta, formatDuration, formatPercent, rateDelta } from './format';
import { rangeLabel, useInsightsRange } from './index';

const SECTION_NAMES: Record<FlowSectionName, string> = {
  runs: 'runs',
  ci: 'CI results',
  flaky: 'flaky checks',
  asks: 'questions',
  ideas: 'ideas',
  rework: 'rework',
  merged: 'merges',
};

export function FlowTab() {
  const { projectId } = useProjectContext();
  const range = useInsightsRange();
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectFlowQueryOptions(queryScope, projectId, range),
    enabled: Boolean(queryScope && projectId),
  });
  const data = query.data;

  if (!data) {
    if (query.isError) {
      return <LoadError what="Insights" error={query.error} onRetry={() => void query.refetch()} />;
    }
    return <Loading label="Loading insights…" />;
  }
  return <FlowBody data={data} projectId={projectId} refreshing={query.isFetching} />;
}

export function FlowBody({
  data,
  projectId,
  refreshing,
}: {
  data: ProjectFlowResponse;
  projectId: string;
  refreshing: boolean;
}) {
  const { ideaToMerged, ciFirstTry, waitingOnPerson, rework } = data.tiles;
  const previous = `vs previous ${rangeLabel(data.range)}`;
  const ideaDelta = durationDelta(ideaToMerged.medianMs, ideaToMerged.previousMedianMs);
  const ciDelta = rateDelta(ciFirstTry.rate, ciFirstTry.previousRate);
  const reworkDelta = rateDelta(rework.rate, rework.previousRate, false);
  const now = Date.parse(data.until);

  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="insights-flow"
    >
      {(refreshing || data.unavailable.length > 0) && (
        <div className="flex min-w-0 flex-col gap-2">
          {refreshing && (
            <span className="flex items-center gap-2 text-[12.5px] text-fg-muted" role="status">
              <Spinner size="sm" /> Updating…
            </span>
          )}
          {data.unavailable.length > 0 && (
            <Notice>
              Some numbers could not be loaded:{' '}
              {data.unavailable.map((s) => SECTION_NAMES[s]).join(', ')}.
            </Notice>
          )}
        </div>
      )}

      <div className="grid min-w-0 grid-cols-2 gap-[var(--sam-space-gutter)] lg:grid-cols-4">
        <Tile
          testId="insights-tile-idea-to-merged"
          label="Idea to merged, median"
          value={
            ideaToMerged.medianMs === null ? 'No merges' : formatDuration(ideaToMerged.medianMs)
          }
          detail={
            ideaDelta
              ? `${ideaDelta.text} ${previous}`
              : ideaToMerged.count > 0
                ? `across ${ideaToMerged.count} ${ideaToMerged.count === 1 ? 'idea' : 'ideas'}`
                : 'No idea merged in this range'
          }
          tone={ideaDelta?.tone}
        />
        <Tile
          testId="insights-tile-ci-first-try"
          label="CI passes first try"
          value={
            ciFirstTry.rate !== null
              ? formatPercent(ciFirstTry.rate)
              : ciFirstTry.recorded === 0
                ? 'Not recorded'
                : 'Waiting on CI'
          }
          detail={
            ciDelta
              ? `${ciDelta.text} ${previous}`
              : ciFirstTry.of > 0
                ? `${ciFirstTry.count} of ${ciFirstTry.of} pull requests`
                : ciFirstTry.recorded === 0
                  ? 'No pull request recorded from its first commit yet'
                  : `${ciFirstTry.recorded} pull requests still running checks`
          }
          tone={ciDelta?.tone}
        />
        <Tile
          testId="insights-tile-waiting"
          label="Waiting on a person, median"
          value={waitingOnPerson.count > 0 ? formatDuration(waitingOnPerson.medianMs) : 'No asks'}
          detail={
            waitingOnPerson.count > 0
              ? `across ${waitingOnPerson.count} ${waitingOnPerson.count === 1 ? 'ask' : 'asks'}`
              : 'No agent asked anyone in this range'
          }
        />
        <Tile
          testId="insights-tile-rework"
          label={`Rework within ${rework.windowDays} days`}
          value={rework.of > 0 ? formatPercent(rework.rate) : 'No merges'}
          detail={
            reworkDelta
              ? `${reworkDelta.text} ${previous}`
              : rework.of > 0
                ? `${rework.count} of ${rework.of} merges had a follow-up`
                : 'Nothing merged in this range'
          }
          tone={reworkDelta?.tone}
        />
      </div>

      <div className="grid min-w-0 gap-[var(--sam-space-gutter)] lg:grid-cols-2">
        <FlowSection
          title={`Runs per ${data.runs.bucket} by outcome`}
          testId="insights-section-runs"
        >
          <RunsChart runs={data.runs} />
        </FlowSection>
        <FlowSection title="Why runs stopped before finishing" testId="insights-section-stops">
          <StopReasons reasons={data.stopReasons} />
        </FlowSection>
      </div>

      <div className="grid min-w-0 gap-[var(--sam-space-gutter)] lg:grid-cols-2">
        <FlowSection
          title="Flaky checks"
          note="same commit, fail then pass"
          testId="insights-section-flaky"
        >
          <FlakyChecks items={data.flakyChecks.items} total={data.flakyChecks.total} />
        </FlowSection>
        <FlowSection title="Ideas waiting longest" testId="insights-section-ideas">
          {data.unavailable.includes('ideas') ? (
            <Empty>Ideas could not be loaded.</Empty>
          ) : (
            <WaitingIdeas
              projectId={projectId}
              items={data.waitingIdeas.items}
              total={data.waitingIdeas.total}
              now={Number.isFinite(now) ? now : Date.now()}
            />
          )}
        </FlowSection>
      </div>

      {ideaToMerged.sampled.truncated && (
        <Notice>
          “Idea to merged” looked at the {ideaToMerged.sampled.cap} most recently updated ideas.
        </Notice>
      )}
    </div>
  );
}
