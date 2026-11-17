/**
 * The Agent setups tab's parts: the setups table (cards on a phone), the comparison bars and the
 * formatting each measure needs. Every measure the records cannot support says so ("Not reported",
 * "Not recorded") instead of printing a zero.
 */
import {
  getAgentDefinition,
  type InsightsSetupGroup,
  type InsightsSetupGrouping,
  isValidAgentType,
} from '@simple-agent-manager/shared';
import type { ReactNode } from 'react';

import { NEUTRAL_COLOR, SERIES_COLORS } from './accounts-parts';
import { Empty } from './flow-parts';
import { formatDuration, formatPercent } from './format';

const GIB = 1024 ** 3;

const NOUN: Record<InsightsSetupGrouping, string> = {
  profile: 'profile',
  skill: 'skill',
  model: 'model',
};

function agentName(agentType: string | null): string {
  if (!agentType) return 'Agent';
  return isValidAgentType(agentType)
    ? (getAgentDefinition(agentType)?.name ?? agentType)
    : agentType;
}

/** A setup's name. A teammate's personal profile or skill is described, never named. */
export function setupTitle(group: InsightsSetupGroup, groupBy: InsightsSetupGrouping): string {
  if (groupBy === 'model' && group.owner === 'not_recorded') return 'Model not recorded';
  if (groupBy === 'model' && !group.label) return `${agentName(group.agentType)} default model`;
  if (group.label && group.owner !== 'teammate') return group.label;
  switch (group.owner) {
    case 'teammate':
      return `A teammate’s ${NOUN[groupBy]}`;
    case 'none':
      return `No ${NOUN[groupBy]}`;
    case 'not_recorded':
      return `Removed ${NOUN[groupBy]}`;
    default:
      return `Unnamed ${NOUN[groupBy]}`;
  }
}

export function setupSubtitle(
  group: InsightsSetupGroup,
  groupBy: InsightsSetupGrouping,
  minRuns: number
): string {
  const used =
    group.usedFor.length === 0
      ? ''
      : groupBy === 'skill'
        ? `with ${group.usedFor.join(', ')}`
        : group.usedFor.join(', ');
  // Below the suggestion minimum a rate moves by ten points per run: say so in words.
  const few = group.finished < minRuns ? 'few runs' : '';
  return [used, few].filter(Boolean).join(' · ');
}

/** "3.1M", "850K", "920". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export function formatGb(bytes: number): string {
  return trim(bytes / GIB);
}

/** A shown measure: its value, a note under it, and whether it covers only some of the runs. */
export interface MeasureText {
  value: string;
  note: string;
  partial?: boolean;
  alert?: boolean;
}

export function tokensText(group: InsightsSetupGroup): MeasureText {
  const t = group.tokens;
  if (t.state === 'not_reported') return { value: 'Not reported', note: 'No run reported tokens' };
  const runs = `${t.reportedRuns} of ${group.runs} ${group.runs === 1 ? 'run' : 'runs'} reported`;
  const partial = t.reportedRuns < group.runs;
  if (t.perMergedPullRequest === null) {
    return { value: 'No merge', note: `${formatTokens(t.total)} used · ${runs}`, partial };
  }
  return { value: formatTokens(t.perMergedPullRequest), note: runs, partial };
}

export function nudgesText(group: InsightsSetupGroup): MeasureText {
  const n = group.nudges;
  if (n.state === 'not_recorded') return { value: 'Not recorded', note: 'Chats not readable' };
  return {
    value: n.perRun.toFixed(1).replace(/\.0$/, ''),
    note: `${n.total} over ${n.runs} ${n.runs === 1 ? 'run' : 'runs'}`,
    partial: n.runs < group.runs,
  };
}

export function memoryText(group: InsightsSetupGroup): MeasureText & { ratio: number | null } {
  const m = group.memory;
  if (m.state === 'not_recorded')
    return { value: 'Not recorded', note: 'No resource telemetry', ratio: null };
  const requested = m.requestedMb === null ? null : m.requestedMb * 1024 * 1024;
  const oom = m.oomKills > 0 ? ` · ${m.oomKills} out of memory` : '';
  return {
    value:
      requested === null
        ? `${formatGb(m.p90Bytes)} GB`
        : `${formatGb(m.p90Bytes)} / ${formatGb(requested)} GB`,
    note: `p90 over ${m.runs} ${m.runs === 1 ? 'run' : 'runs'}${oom}`,
    ratio: requested ? Math.min(1, m.p90Bytes / requested) : null,
    alert: m.oomKills > 0,
  };
}

function MemoryBar({ ratio }: { ratio: number | null }) {
  if (ratio === null) return null;
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-full max-w-[90px] overflow-hidden rounded-full bg-[var(--sam-hairline)]"
      data-intentional-clip="rounded bar ends"
    >
      <span
        className="block h-full rounded-full bg-fg-muted"
        style={{ width: `${Math.max(4, ratio * 100)}%` }}
      />
    </span>
  );
}

function SetupMark({ color, title }: { color: string; title: string }) {
  return (
    <span
      aria-hidden="true"
      className="sam-raised grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-fg-muted"
      style={{ boxShadow: `inset 0 0 0 2px ${color}` }}
    >
      {title.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** Colour per setup: the first five keep a series colour, the rest and the fallback rows are neutral. */
export function setupColors(groups: InsightsSetupGroup[]): Map<string, string> {
  const colors = new Map<string, string>();
  let next = 0;
  for (const group of groups) {
    const fallback = group.owner === 'none' || group.owner === 'not_recorded';
    const color = !fallback ? SERIES_COLORS[next] : undefined;
    if (color) next += 1;
    colors.set(group.key, color ?? NEUTRAL_COLOR);
  }
  return colors;
}

/**
 * A value and its note. `partial` says in words that the value covers only some runs, so it is
 * not read as comparable with a setup whose every run reported; `alert` keeps an out-of-memory
 * note at full contrast rather than muted.
 */
function Measure({
  value,
  note,
  noWrap,
  partial,
  alert,
}: {
  value: ReactNode;
  note?: string;
  noWrap?: boolean;
  partial?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
        {value}
        {partial && <span className="ml-1 text-[11.5px] font-medium">· partial</span>}
      </span>
      {note && (
        <span
          className={`text-[11.5px] ${alert ? 'font-medium text-fg-primary' : 'text-fg-muted'} ${noWrap ? 'whitespace-nowrap' : ''}`}
        >
          {note}
        </span>
      )}
    </div>
  );
}

const COLUMNS = [
  'Runs',
  'Merged without rework',
  'Median to pull request',
  'Nudges per run',
  'Tokens per merged PR',
  'Memory p90 / requested',
] as const;

/** One row per setup: a table on wide screens, a card per setup on a phone. */
export function SetupsTable({
  groups,
  groupBy,
  colors,
  minRuns,
}: {
  groups: InsightsSetupGroup[];
  groupBy: InsightsSetupGrouping;
  colors: Map<string, string>;
  minRuns: number;
}) {
  const rows = groups.map((group) => {
    const title = setupTitle(group, groupBy);
    return {
      group,
      title,
      subtitle: setupSubtitle(group, groupBy, minRuns),
      color: colors.get(group.key) ?? NEUTRAL_COLOR,
      clean: {
        value: formatPercent(group.mergedCleanRate),
        note: `${group.mergedClean} of ${group.finished} finished`,
      },
      toPr: {
        value: formatDuration(group.medianToPullRequestMs),
        note:
          group.pullRequests > 0
            ? `${group.pullRequests} ${group.pullRequests === 1 ? 'pull request' : 'pull requests'}`
            : 'No pull request',
      },
      nudges: nudgesText(group),
      tokens: tokensText(group),
      memory: memoryText(group),
    };
  });
  return (
    <>
      <table
        className="hidden w-full min-w-0 border-collapse text-left lg:table"
        aria-label={`Agent setups by ${NOUN[groupBy]}`}
        data-testid="insights-setups-table"
      >
        <thead>
          <tr className="border-b border-[var(--sam-hairline)]">
            <th
              scope="col"
              className="min-w-[170px] py-2 pr-3 text-[11.5px] font-semibold uppercase tracking-wide text-fg-muted"
            >
              {NOUN[groupBy]}
            </th>
            {COLUMNS.map((label) => (
              <th
                key={label}
                scope="col"
                className="px-2 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-fg-muted"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.group.key}
              className="border-b border-[var(--sam-hairline)] last:border-b-0 align-top"
            >
              <th scope="row" className="py-3 pr-3 font-normal">
                <div className="flex min-w-0 items-center gap-2.5">
                  <SetupMark color={row.color} title={row.title} />
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                      {row.title}
                    </div>
                    {row.subtitle && (
                      <div className="text-[12px] text-fg-muted [overflow-wrap:anywhere]">
                        {row.subtitle}
                      </div>
                    )}
                  </div>
                </div>
              </th>
              <td className="px-2 py-3">
                <Measure value={row.group.runs} note={`${row.group.merged} merged`} noWrap />
              </td>
              <td className="px-2 py-3">
                <Measure {...row.clean} />
              </td>
              <td className="px-2 py-3">
                <Measure {...row.toPr} />
              </td>
              <td className="px-2 py-3">
                <Measure {...row.nudges} />
              </td>
              <td className="px-2 py-3">
                <Measure {...row.tokens} />
              </td>
              <td className="px-2 py-3">
                <div className="flex flex-col gap-1">
                  <Measure {...row.memory} />
                  <MemoryBar ratio={row.memory.ratio} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul
        className="m-0 flex list-none flex-col gap-3 p-0 lg:hidden"
        data-testid="insights-setups-cards"
      >
        {rows.map((row) => (
          <li
            key={row.group.key}
            className="flex min-w-0 flex-col gap-3 border-b border-[var(--sam-hairline)] pb-3 last:border-b-0 last:pb-0"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <SetupMark color={row.color} title={row.title} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                  {row.title}
                </div>
                {row.subtitle && (
                  <div className="text-[12px] text-fg-muted [overflow-wrap:anywhere]">
                    {row.subtitle}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-right text-[12.5px] text-fg-muted">
                {row.group.runs} {row.group.runs === 1 ? 'run' : 'runs'}
                <br />
                {row.group.merged} merged
              </span>
            </div>
            <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5">
              {(
                [
                  ['Merged without rework', row.clean],
                  ['Median to PR', row.toPr],
                  ['Nudges per run', row.nudges],
                  ['Tokens per merged PR', row.tokens],
                  ['Memory p90 / requested', row.memory],
                ] as const
              ).map(([label, measure]) => (
                <div key={label} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-[11.5px] text-fg-muted">{label}</dt>
                  <dd className="m-0">
                    <Measure {...measure} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

interface CompareMetric {
  title: string;
  hint: string;
  value: (group: InsightsSetupGroup) => number | null;
  format: (value: number) => string;
}

const COMPARE_METRICS: CompareMetric[] = [
  {
    title: 'Merged without rework',
    hint: 'higher is better',
    value: (g) => g.mergedCleanRate,
    format: (v) => formatPercent(v),
  },
  {
    title: 'Median minutes to PR',
    hint: 'lower is faster',
    value: (g) => (g.medianToPullRequestMs === null ? null : g.medianToPullRequestMs / 60_000),
    // A median under half a minute still shows as 1, never as a misleading 0.
    format: (v) => String(Math.max(v > 0 ? 1 : 0, Math.round(v))),
  },
  {
    title: 'Human nudges per run',
    hint: 'lower is calmer',
    value: (g) => (g.nudges.state === 'measured' ? g.nudges.perRun : null),
    format: (v) => v.toFixed(1).replace(/\.0$/, ''),
  },
];

/**
 * The setups side by side on three measures: plain HTML bars, each row named in text so no setup
 * is told apart by colour alone, and each list exposed as one image with a text equivalent.
 */
export function CompareBars({
  groups,
  groupBy,
  colors,
}: {
  groups: InsightsSetupGroup[];
  groupBy: InsightsSetupGrouping;
  colors: Map<string, string>;
}) {
  if (groups.length < 2) {
    return <Empty>Compare needs at least two setups with runs in this range.</Empty>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="insights-setups-compare">
      {COMPARE_METRICS.map((metric) => {
        const values = groups.map((g) => metric.value(g));
        const max = Math.max(1e-9, ...values.map((v) => v ?? 0));
        return (
          <figure key={metric.title} className="m-0 flex min-w-0 flex-col gap-1.5">
            <figcaption className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold text-fg-primary">{metric.title}</span>
              <span className="text-[11.5px] text-fg-muted">{metric.hint}</span>
            </figcaption>
            <ul
              role="img"
              className="m-0 flex list-none flex-col gap-1.5 p-0"
              aria-label={`${metric.title}: ${groups
                .map((g, i) => {
                  const v = values[i];
                  return `${setupTitle(g, groupBy)} ${v === null || v === undefined ? 'not recorded' : metric.format(v)}`;
                })
                .join('; ')}`}
            >
              {groups.map((group, i) => {
                const value = values[i];
                return (
                  <li
                    key={group.key}
                    className="grid min-w-0 grid-cols-[minmax(0,38%)_1fr] items-center gap-2"
                  >
                    <span className="line-clamp-1 break-words text-[12px] text-fg-muted">
                      {setupTitle(group, groupBy)}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      {value === null || value === undefined ? (
                        <span className="text-[11.5px] text-fg-muted">Not recorded</span>
                      ) : (
                        <>
                          <span
                            className="block h-3.5 rounded-[4px]"
                            style={{
                              width: `${Math.max(3, (value / max) * 78)}%`,
                              background: colors.get(group.key) ?? NEUTRAL_COLOR,
                            }}
                          />
                          <span className="shrink-0 font-mono text-[11.5px] text-fg-primary">
                            {metric.format(value)}
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        );
      })}
    </div>
  );
}
