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
import { cpuPointsForRun, ReceiptCpuLine } from './ReceiptCpuLine';

const sectionHeading =
  'm-0 mt-5 mb-2 text-[length:var(--sam-type-section-heading-size)] font-[var(--sam-type-section-heading-weight)] text-fg-primary';

function PhaseBar({ phases, live }: Readonly<{ phases: RunReceiptPhase[]; live: boolean }>) {
  const measured = phases.filter((phase) => (phase.durationMs ?? 0) > 0);
  const total = measured.reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0);
  const summary = phases
    .map((phase) => `${PHASE_LABEL[phase.key]} ${formatDuration(phase.durationMs, live)}`)
    .join(', ');
  return (
    <div>
      <div
        className="flex h-3 w-full rounded-full bg-[var(--sam-glass-nested-bg)]"
        role="img"
        aria-label={`Where the time went: ${summary}`}
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
      <ul className="m-0 mt-2.5 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
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
}: Readonly<{ label: string; value: string; note: string }>) {
  return (
    <div className="min-w-0 rounded-[var(--sam-radius-control)] border border-[var(--sam-hairline)] bg-[var(--sam-glass-nested-bg)] px-3 py-2.5">
      <div className="text-[length:var(--sam-type-caption-size)] text-fg-muted">{label}</div>
      <div className="mt-0.5 line-clamp-3 break-words text-lg font-semibold leading-tight text-fg-primary">
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
  ci_failing: <AlertTriangle size={18} />,
  oom: <MemoryStick size={18} />,
  memory: <MemoryStick size={18} />,
};

export function RunReceiptView({
  receipt,
  resourceIndex,
}: Readonly<{ receipt: RunReceipt; resourceIndex: ResourceTimelineIndex | undefined }>) {
  const outcome = outcomeLabel(receipt);
  const account = accountTile(receipt.account);
  const { resources, toolCalls } = receipt;
  const from = Date.parse(receipt.createdAt);
  const to = Date.parse(receipt.endedAt);
  const points = cpuPointsForRun(resourceIndex, from, to);
  const reservedCores =
    resources.requestedCpuMillis !== null ? resources.requestedCpuMillis / 1000 : null;
  const pr = receipt.outcome.pullRequest;

  return (
    <div data-testid="run-receipt">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          tone={outcome.tone}
          icon={pr?.state === 'merged' ? <GitMerge size={13} /> : undefined}
        >
          {outcome.label}
        </Chip>
        <span className="text-[length:var(--sam-type-secondary-size)] text-fg-muted">
          {outcomeLine(receipt)}
        </span>
      </div>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block break-words text-[length:var(--sam-type-secondary-size)] text-[var(--sam-color-accent-primary)] underline-offset-2 hover:underline"
        >
          {pr.title ? `#${pr.number} ${pr.title}` : `${pr.repository}#${pr.number}`}
        </a>
      )}

      <h3 className={sectionHeading}>Where the time went</h3>
      <PhaseBar phases={receipt.phases} live={receipt.live} />

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <StatTile
          label="Tokens"
          value="Not reported"
          note="Token use is not recorded yet; SAM never estimates it"
        />
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
              : 'Not available for this chat'
          }
        />
      </div>

      <h3 className={sectionHeading}>CPU, with the tool calls behind the peaks</h3>
      {points.length >= 2 ? (
        <ReceiptCpuLine points={points} reservedCores={reservedCores} />
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
          Nothing stood out against recent runs.
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
