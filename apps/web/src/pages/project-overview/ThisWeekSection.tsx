/**
 * This week (Insights slice F): three numbers and the top blocker for the last 7 days, linking
 * into Insights. It reads the same `projectFlow` the Insights page reads, under the same query
 * key as its 7-day range, so the two never disagree and opening one warms the other. It is a
 * separate request from the Overview's aggregated read, which keeps that read's round trips
 * unchanged.
 */
import {
  FLOW_STOP_REASON_LABELS,
  type FlowTopBlocker,
  type ProjectFlowResponse,
} from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { projectFlowQueryOptions } from '../../lib/query-options';
import {
  countDelta,
  DELTA_TONE_CLASS,
  type DeltaTone,
  durationDelta,
  formatDurationShort,
  formatPercent,
  rateDelta,
} from '../insights/format';
import { Section, SectionHead, SectionNote } from './sections';

function Stat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: { text: string; tone: DeltaTone } | null;
}) {
  return (
    <div className="sam-well flex min-w-0 flex-col gap-0.5 rounded-[var(--sam-radius-control)] px-2.5 py-2">
      <span className="text-[12px] leading-tight text-fg-muted">{label}</span>
      <span className="text-[19px] font-bold leading-tight text-fg-primary">{value}</span>
      {/* A flat change says nothing in a cell this small; the line keeps its height. */}
      <span className={`text-[11.5px] ${delta ? DELTA_TONE_CLASS[delta.tone] : 'text-fg-muted'}`}>
        {delta && delta.tone !== 'flat' ? (
          <>
            {delta.text}
            <span className="sr-only"> compared with the 7 days before</span>
          </>
        ) : (
          '\u00a0'
        )}
      </span>
    </div>
  );
}

export function blockerText(blocker: FlowTopBlocker): { lead: string; rest: string } {
  if (blocker.kind === 'flaky_check') {
    return {
      lead: `Flaky check: ${blocker.name}`,
      rest: `failed, then passed on the same commit ${blocker.flips} ${blocker.flips === 1 ? 'time' : 'times'}`,
    };
  }
  return {
    lead: FLOW_STOP_REASON_LABELS[blocker.reason],
    rest: `${blocker.count} ${blocker.count === 1 ? 'run' : 'runs'} stopped on this`,
  };
}

export function ThisWeekBody({ data }: { data: ProjectFlowResponse }) {
  const { ideaToMerged, ciFirstTry } = data.tiles;
  const blocker = data.topBlocker ? blockerText(data.topBlocker) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 px-1">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Merged"
          value={String(data.merged.count)}
          delta={countDelta(data.merged.count, data.merged.previous)}
        />
        <Stat
          label="Idea → merged"
          value={formatDurationShort(ideaToMerged.medianMs)}
          delta={durationDelta(ideaToMerged.medianMs, ideaToMerged.previousMedianMs)}
        />
        <Stat
          label="CI first try"
          value={formatPercent(ciFirstTry.rate)}
          delta={rateDelta(ciFirstTry.rate, ciFirstTry.previousRate)}
        />
      </div>
      <div
        className="sam-well flex min-w-0 items-start gap-2 rounded-[var(--sam-radius-control)] px-2.5 py-2"
        data-testid="overview-this-week-blocker"
      >
        {blocker ? (
          <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-danger-fg" />
        ) : (
          <CircleCheck
            size={16}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--sam-status-success-fg)]"
          />
        )}
        <p className="m-0 min-w-0 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
          {blocker ? (
            <>
              <span className="font-semibold text-fg-primary">{blocker.lead}</span> · {blocker.rest}
            </>
          ) : (
            'Nothing stopped runs this week.'
          )}
        </p>
      </div>
    </div>
  );
}

export function ThisWeekSection({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectFlowQueryOptions(queryScope, projectId, '7d'),
    enabled: Boolean(queryScope && projectId),
  });
  return (
    <Section label="This week" className={className}>
      <SectionHead
        title="This week"
        to={`/projects/${projectId}/insights/flow?range=7d`}
        linkLabel="Insights"
      />
      {query.data ? (
        <ThisWeekBody data={query.data} />
      ) : query.isError ? (
        <SectionNote>Couldn’t load this week’s numbers.</SectionNote>
      ) : (
        <SectionNote>Loading…</SectionNote>
      )}
    </Section>
  );
}
