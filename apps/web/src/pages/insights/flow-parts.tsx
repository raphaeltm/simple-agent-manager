/**
 * The Flow tab's sections. Charts are plain HTML bars rather than a chart library: they wrap and
 * shrink with the pane at 375px, and each carries a text equivalent for screen readers.
 */
import {
  FLOW_STOP_REASON_LABELS,
  type FlowFlakyCheck,
  type FlowRuns,
  type FlowStopReasonCount,
  type FlowWaitingIdea,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import { Lightbulb, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { bucketLabel, bucketTotal, daysSince, DELTA_TONE_CLASS, type DeltaTone } from './format';

/** One figure: its label, the value, and a line under it (a change or what it counts). */
export function Tile({
  label,
  value,
  detail,
  tone,
  testId,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  tone?: DeltaTone;
  testId?: string;
}) {
  return (
    <Pane
      className="flex min-w-0 flex-col gap-1 px-4 py-3.5"
      aria-label={label}
      data-testid={testId}
    >
      {/* Two lines reserved on phones, so the figures in a row line up. */}
      <span className="text-[13px] text-fg-muted max-sm:min-h-[2.8em]">{label}</span>
      <span className="text-[22px] font-bold leading-tight text-fg-primary [overflow-wrap:anywhere] sm:text-[26px]">
        {value}
      </span>
      {detail && (
        <span className={`text-[12.5px] ${tone ? DELTA_TONE_CLASS[tone] : 'text-fg-muted'}`}>
          {detail}
        </span>
      )}
    </Pane>
  );
}

/** A section pane with a heading and an optional note on the right. */
export function FlowSection({
  title,
  note,
  children,
  testId,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Pane
      className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5"
      aria-label={title}
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{title}</h2>
        {note && <span className="text-[12.5px] text-fg-muted">{note}</span>}
      </div>
      {children}
    </Pane>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[13.5px] text-fg-muted">{children}</p>;
}

const SERIES = [
  { key: 'merged', label: 'Merged', color: 'bg-[var(--sam-color-success)]' },
  { key: 'closed', label: 'Closed without merge', color: 'bg-[var(--sam-color-purple)]' },
  { key: 'failed', label: 'Failed', color: 'bg-[var(--sam-color-danger)]' },
] as const;

export function RunsChart({ runs }: { runs: FlowRuns }) {
  const max = Math.max(1, ...runs.buckets.map(bucketTotal));
  // 90 days is 14 weeks: on a phone, totals above the bars and every other label would collide.
  const dense = runs.buckets.length > 8;
  const total = runs.buckets.reduce((sum, b) => sum + bucketTotal(b), 0);
  const { stopped, prOpen, noPullRequest } = runs.other;
  const extras = [
    stopped > 0 && `${stopped} stopped`,
    prOpen > 0 && `${prOpen} waiting to merge`,
    noPullRequest > 0 && `${noPullRequest} without a pull request`,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-runs-chart">
      {total === 0 ? (
        <Empty>No runs finished with a merge, a closed pull request or a failure.</Empty>
      ) : (
        <>
          <div
            role="img"
            aria-label={`Runs per ${runs.bucket}: ${runs.buckets
              .map(
                (b) =>
                  `${bucketLabel(b.start, runs.bucket)} ${b.merged} merged, ${b.closed} closed, ${b.failed} failed`
              )
              .join('; ')}`}
            className="flex h-[150px] min-w-0 items-end gap-1.5 sm:gap-2"
          >
            {runs.buckets.map((b) => (
              <div key={b.start} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
                <span
                  className={`font-mono text-[11px] text-fg-muted ${dense ? 'max-sm:invisible' : ''}`}
                >
                  {bucketTotal(b) || ''}
                </span>
                <div
                  className="flex w-full max-w-[36px] flex-1 flex-col-reverse overflow-hidden rounded-[5px]"
                  data-intentional-clip="rounded bar ends"
                >
                  {SERIES.map((s) => (
                    <div
                      key={s.key}
                      className={s.color}
                      style={{ height: `${(b[s.key] / max) * 100}%` }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex min-w-0 gap-1.5 sm:gap-2" aria-hidden="true">
            {runs.buckets.map((b, index) => (
              <span
                key={b.start}
                className={`min-w-0 flex-1 whitespace-nowrap text-center font-mono text-[10.5px] text-fg-muted ${dense && index % 2 === 1 ? 'max-sm:invisible' : ''}`}
              >
                {bucketLabel(b.start, runs.bucket)}
              </span>
            ))}
          </div>
        </>
      )}
      {total > 0 && <p className="m-0 text-[12.5px] text-fg-muted">{peakSummary(runs, total)}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[12.5px] text-fg-muted">
            <span aria-hidden="true" className={`size-2.5 rounded-sm ${s.color}`} />
            {s.label}
          </span>
        ))}
      </div>
      {extras.length > 0 && (
        <p className="m-0 text-[12.5px] text-fg-muted">Also: {extras.join(' · ')}</p>
      )}
    </div>
  );
}

/** "153 runs · busiest W44 with 31": the totals a phone hides above the bars, in words. */
function peakSummary(runs: FlowRuns, total: number): string {
  const peak = runs.buckets.reduce((best, b) => (bucketTotal(b) > bucketTotal(best) ? b : best));
  return `${total} ${total === 1 ? 'run' : 'runs'} · busiest ${bucketLabel(peak.start, runs.bucket)} with ${bucketTotal(peak)}`;
}

export function StopReasons({ reasons }: { reasons: FlowStopReasonCount[] }) {
  if (reasons.length === 0) return <Empty>No run stopped before finishing.</Empty>;
  const max = Math.max(1, ...reasons.map((r) => r.count));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="insights-stop-reasons">
      {reasons.map((r) => (
        <li key={r.reason} className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0 text-[13px] text-fg-primary [overflow-wrap:anywhere]">
              {FLOW_STOP_REASON_LABELS[r.reason]}
            </span>
            <span className="font-mono text-[12.5px] text-fg-muted">{r.count}</span>
          </div>
          <div aria-hidden="true" className="h-2 rounded-full bg-[var(--sam-hairline)]">
            <div
              className="h-full rounded-full bg-[var(--sam-color-info)]"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FlakyChecks({ items, total }: { items: FlowFlakyCheck[]; total: number }) {
  if (items.length === 0) {
    return (
      <Empty>
        No flaky checks. A check counts as flaky when it fails and then passes on the same commit.
      </Empty>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      <ul className="m-0 flex list-none flex-col p-0" data-testid="insights-flaky-checks">
        {items.map((check, index) => (
          <li
            key={check.name}
            className={`flex min-w-0 items-start gap-2.5 py-2.5 ${index > 0 ? 'border-0 border-t border-solid border-[var(--sam-hairline)]' : ''}`}
          >
            <TriangleAlert
              size={16}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-danger-fg"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 break-words text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                {check.name}
              </span>
              <span className="text-[12.5px] text-fg-muted">
                Failed, then passed on the same commit, on {check.flips} of {check.commits}{' '}
                {check.commits === 1 ? 'commit' : 'commits'}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className="m-0 pt-1 text-[12.5px] text-fg-muted">
          Showing {items.length} of {total} flaky checks.
        </p>
      )}
    </div>
  );
}

function ideaStateText(idea: FlowWaitingIdea): string {
  switch (idea.state) {
    case 'not-started':
      return 'not started';
    case 'working':
      return 'an agent is working on it';
    case 'review':
      return idea.pullRequest?.checksState === 'failure' ? 'PR open, CI red' : 'PR open';
    case 'merged':
      return 'merged, waiting for someone to close it';
    case 'stuck':
      return 'stuck';
    case 'question':
      return 'waiting on an answer';
    case 'done':
      return 'done';
    case 'parked':
      return 'parked';
  }
}

export function WaitingIdeas({
  projectId,
  items,
  total,
  now,
}: {
  projectId: string;
  items: FlowWaitingIdea[];
  total: number;
  now: number;
}) {
  if (items.length === 0) return <Empty>No open ideas filed in this range.</Empty>;
  return (
    <div className="flex min-w-0 flex-col">
      <ul className="m-0 flex list-none flex-col p-0" data-testid="insights-waiting-ideas">
        {items.map((idea, index) => {
          const days = daysSince(idea.createdAt, now);
          const runs =
            idea.chats > 0 ? ` · ${idea.chats} ${idea.chats === 1 ? 'run' : 'runs'}` : '';
          return (
            <li
              key={idea.ideaId}
              className={
                index > 0 ? 'border-0 border-t border-solid border-[var(--sam-hairline)]' : ''
              }
            >
              <Link
                to={`/projects/${projectId}/ideas/${idea.ideaId}`}
                className="flex min-h-11 min-w-0 items-start gap-2.5 rounded-md py-2.5 no-underline hover:bg-surface-hover"
              >
                <Lightbulb size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-fg-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 break-words text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                    {idea.title}
                  </span>
                  <span className="text-[12.5px] text-fg-muted">
                    {days} {days === 1 ? 'day' : 'days'}
                    {runs} · {ideaStateText(idea)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {total > items.length && (
        <p className="m-0 pt-1 text-[12.5px] text-fg-muted">
          {total - items.length} more open {total - items.length === 1 ? 'idea' : 'ideas'} from this
          range on the{' '}
          <Link to={`/projects/${projectId}/ideas`} className="text-fg-primary">
            Ideas page
          </Link>
          .
        </p>
      )}
    </div>
  );
}
