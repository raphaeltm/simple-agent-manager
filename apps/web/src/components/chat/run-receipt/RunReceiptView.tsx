/**
 * The Run receipt's content (Insights slice R): outcome, where the time went, stat tiles, the
 * CPU line and what slowed the run down. Presentational only; `SessionReceiptDrawer` owns the
 * reads. Layout follows the Library prototype `/product/analytics/analytics-prototypes.html`
 * (`?s=receipt`).
 */
import type { RunReceipt, RunReceiptPhase } from '@simple-agent-manager/shared';
import { Chip } from '@simple-agent-manager/ui';
import { AlertTriangle, Clock, Cpu, GitMerge, HelpCircle, MemoryStick } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatBytes } from '../resource-timeline/format';
import type { ResourceTimelineIndex } from '../resource-timeline/types';
import {
  accountTile,
  formatDuration,
  outcomeLabel,
  outcomeLine,
  PHASE_COLOR,
  PHASE_LABEL,
  slowItemText,
  toolKindSummary,
  unavailableSummary,
} from './receipt-format';
import { modelSpendLabel, modelTokenParts, spendLabel, tokensTile } from './receipt-tokens';
import { cpuPointsForRun, ReceiptCpuLine } from './ReceiptCpuLine';

// Sub-headings inside the panel sit below the panel title in the type scale.
const sectionHeading = 'm-0 mt-5 mb-2 text-sm font-semibold leading-[1.3] text-fg-primary';

function PhaseBar({ phases, live }: Readonly<{ phases: RunReceiptPhase[]; live: boolean }>) {
  const measured = phases.filter((phase) => (phase.durationMs ?? 0) > 0);
  const total = measured.reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0);
  const summary = phases
    .map((phase) => `${PHASE_LABEL[phase.key]} ${formatDuration(phase.durationMs, live)}`)
    .join(', ');
  return (
    <div>
      {/* The legend below carries the same durations as text, so the bar is decorative to
          assistive technology rather than announced twice. */}
      <div
        className="flex h-3 w-full rounded-full bg-[var(--sam-glass-nested-bg)]"
        aria-hidden="true"
        data-summary={summary}
        data-testid="receipt-phase-bar"
      >
        {/* Flex growth in proportion to each phase, so the segments always fill the bar exactly
            and a tiny phase still shows (min width) without pushing the bar past its box. */}
        {total > 0 &&
          measured.map((phase) => (
            <span
              key={phase.key}
              data-phase={phase.key}
              className="h-full min-w-[4px] border-r-2 border-[var(--sam-glass-nested-bg)] first:rounded-l-full last:rounded-r-full last:border-r-0"
              style={{
                flex: `${phase.durationMs ?? 0} 1 0`,
                background: PHASE_COLOR[phase.key],
              }}
            />
          ))}
      </div>
      <ul className="m-0 mt-2.5 grid list-none grid-cols-1 gap-x-4 gap-y-1.5 p-0 min-[400px]:grid-cols-2">
        {phases.map((phase) => (
          <li
            key={phase.key}
            className="flex items-center gap-1.5 text-[length:var(--sam-type-secondary-size)] text-fg-primary"
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: PHASE_COLOR[phase.key] }}
            />
            <span>{PHASE_LABEL[phase.key]}</span>
            <span className="font-mono text-fg-muted">
              {formatDuration(phase.durationMs, live)}
              {phase.limited && phase.durationMs !== null ? '+' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
  muted = false,
}: Readonly<{ label: string; value: string; note: string; muted?: boolean }>) {
  return (
    <div className="min-w-0 rounded-[var(--sam-radius-control)] border border-[var(--sam-hairline)] bg-[var(--sam-glass-nested-bg)] px-3 py-2.5">
      <div className="text-[length:var(--sam-type-caption-size)] text-fg-muted">{label}</div>
      <div
        className={`mt-0.5 line-clamp-3 break-words text-lg font-semibold leading-tight ${muted ? 'text-fg-muted' : 'text-fg-primary'}`}
        title={value}
      >
        {value}
      </div>
      <div className="mt-0.5 break-words text-[length:var(--sam-type-caption-size)] text-fg-muted">
        {note}
      </div>
    </div>
  );
}

const SLOW_ICON: Record<string, ReactNode> = {
  machine: <Clock size={18} />,
  setup: <Clock size={18} />,
  waiting: <HelpCircle size={18} />,
  ci_failing: <AlertTriangle size={18} className="text-[var(--sam-color-danger-fg)]" />,
  oom: <MemoryStick size={18} />,
  memory: <MemoryStick size={18} />,
};

/** What the CPU section shows while its history loads, if it fails, or when there is none. */
export type CpuHistoryState = 'loading' | 'error' | 'ready';

export function RunReceiptView({
  receipt,
  resourceIndex,
  cpuHistory = 'ready',
}: Readonly<{
  receipt: RunReceipt;
  resourceIndex: ResourceTimelineIndex | undefined;
  cpuHistory?: CpuHistoryState;
}>) {
  const outcome = outcomeLabel(receipt);
  const account = accountTile(receipt.account);
  const tokens = tokensTile(receipt.tokens, {
    live: receipt.live,
    unavailable: receipt.unavailable.includes('tokens'),
  });
  const spend = spendLabel(receipt.tokens);
  const { resources, toolCalls } = receipt;
  const from = Date.parse(receipt.createdAt);
  const to = Date.parse(receipt.endedAt);
  const points = cpuPointsForRun(resourceIndex, from, to);
  const reservedCores =
    resources.requestedCpuMillis !== null ? resources.requestedCpuMillis / 1000 : null;
  const pr = receipt.outcome.pullRequest;
  // The server only returns https pull request URLs; checked again here so a future writer can
  // never turn this link into a script URL.
  const prHref = pr && /^https:\/\//i.test(pr.url) ? pr.url : null;

  return (
    <div data-testid="run-receipt">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          tone={outcome.tone}
          dot={receipt.live}
          icon={pr?.state === 'merged' ? <GitMerge size={13} /> : undefined}
        >
          {outcome.label}
        </Chip>
        <span className="text-[length:var(--sam-type-secondary-size)] text-fg-muted">
          {outcomeLine(receipt)}
        </span>
      </div>
      {pr && prHref && (
        <a
          href={prHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex min-h-11 items-center break-words text-[length:var(--sam-type-secondary-size)] text-[var(--sam-color-accent-primary)] underline underline-offset-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <span>
            {pr.title ? `#${pr.number} ${pr.title}` : `${pr.repository}#${pr.number}`}
            <span className="sr-only"> (opens in a new tab)</span>
          </span>
        </a>
      )}

      <h3 className={sectionHeading}>Where the time went</h3>
      <PhaseBar phases={receipt.phases} live={receipt.live} />

      <div className="mt-4 grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2">
        <StatTile label="Tokens" value={tokens.value} note={tokens.note} muted={tokens.muted} />
        <StatTile label="Account" value={account.value} note={account.note} />
        <StatTile
          label="Peak memory"
          value={resources.peakMemoryBytes !== null ? formatBytes(resources.peakMemoryBytes) : '—'}
          note={
            !resources.measured
              ? 'No resource history for this run'
              : resources.requestedMemoryMb !== null
                ? `of ${formatBytes(resources.requestedMemoryMb * 1024 * 1024)} requested`
                : 'Request not recorded'
          }
        />
        <StatTile
          label="Tool calls"
          value={toolCalls ? `${toolCalls.total}${toolCalls.scanLimited ? '+' : ''}` : '—'}
          note={
            toolCalls
              ? toolKindSummary(toolCalls.byKind) || 'No tool calls'
              : receipt.unavailable.includes('toolCalls')
                ? 'Could not be read just now'
                : 'Not available for this chat'
          }
        />
      </div>

      {receipt.tokens.state === 'reported' && receipt.tokens.models.length > 0 && (
        <>
          <h3 className={sectionHeading}>Tokens by model</h3>
          <ul
            className="m-0 list-none divide-y divide-[var(--sam-hairline)] p-0"
            data-testid="receipt-token-models"
          >
            {receipt.tokens.models.map((model) => {
              const modelSpend = modelSpendLabel(receipt.tokens, model);
              return (
                <li key={model.model ?? ''} className="flex items-start gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold text-fg-primary [overflow-wrap:anywhere]">
                      {model.model ?? 'Model not reported'}
                    </span>
                    <span className="flex flex-wrap gap-x-1.5 font-mono text-[length:var(--sam-type-secondary-size)] text-fg-muted">
                      {modelTokenParts(model).map((part, index) => (
                        <span key={part} className="whitespace-nowrap">
                          {index > 0 ? '· ' : ''}
                          {part}
                        </span>
                      ))}
                    </span>
                  </span>
                  {modelSpend && (
                    <span className="shrink-0 font-mono text-[length:var(--sam-type-secondary-size)] text-fg-muted">
                      {modelSpend}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {spend && (
            <p
              className="m-0 mt-1 text-[length:var(--sam-type-caption-size)] text-fg-muted"
              data-testid="receipt-token-spend"
            >
              {spend}
            </p>
          )}
        </>
      )}

      <h3 className={sectionHeading}>CPU and tool calls</h3>
      {points.length >= 2 ? (
        <ReceiptCpuLine points={points} reservedCores={reservedCores} from={from} to={to} />
      ) : cpuHistory === 'loading' ? (
        // Same height as the chart, so the panel does not jump when it arrives.
        <div
          className="h-[7.5rem] animate-pulse rounded-[var(--sam-radius-control)] bg-[var(--sam-glass-nested-bg)]"
          data-testid="receipt-cpu-loading"
        >
          <span className="sr-only">Loading CPU history</span>
        </div>
      ) : cpuHistory === 'error' ? (
        <p className="m-0 flex items-center gap-2 text-[length:var(--sam-type-secondary-size)] text-fg-muted">
          <Cpu size={16} aria-hidden="true" />
          Couldn&apos;t load CPU history just now.
        </p>
      ) : (
        <p className="m-0 flex items-center gap-2 text-[length:var(--sam-type-secondary-size)] text-fg-muted">
          <Cpu size={16} aria-hidden="true" />
          {resources.peakCpuMillis !== null
            ? `Peak ${(resources.peakCpuMillis / 1000).toFixed(1)} cores. No per-minute history to draw.`
            : 'No CPU history was recorded for this run.'}
        </p>
      )}

      <h3 className={sectionHeading}>What slowed it down</h3>
      {receipt.slowedDown.length === 0 ? (
        <p className="m-0 text-[length:var(--sam-type-secondary-size)] text-fg-muted">
          {receipt.unavailable.includes('comparison')
            ? 'Nothing stood out. No comparison with recent runs was available.'
            : 'Nothing stood out against recent runs.'}
        </p>
      ) : (
        <ul className="m-0 list-none divide-y divide-[var(--sam-hairline)] p-0">
          {receipt.slowedDown.map((item, index) => {
            const text = slowItemText(item);
            return (
              <li key={`${item.kind}-${index}`} className="flex gap-3 py-2.5">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${item.kind === 'waiting' ? 'text-[var(--sam-color-warning-fg)]' : 'text-fg-muted'}`}
                >
                  {SLOW_ICON[item.kind]}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-fg-primary">{text.title}</span>
                  {text.detail && (
                    <span className="block break-words text-[length:var(--sam-type-secondary-size)] text-fg-muted">
                      {text.detail}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {receipt.unavailable.length > 0 && (
        <p className="m-0 mt-4 text-[length:var(--sam-type-caption-size)] text-fg-muted">
          Could not read {unavailableSummary(receipt.unavailable)} just now.
        </p>
      )}
    </div>
  );
}
