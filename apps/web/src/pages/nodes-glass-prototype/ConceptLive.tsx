// PROTOTYPE ONLY — Concept 2, "Live".
//
// Time first. Each machine shows the last 30 minutes of what its sessions used, stacked,
// under two lines: what SAM set aside for them, and the size of the machine. Each
// session row carries its own sparkline with its reservation as a dashed ceiling, so
// "asked for 8 GB, never went above 2" is visible without opening anything.
import { Pane, SegmentedControl } from '@simple-agent-manager/ui';
import { useState } from 'react';

import type { ProtoMachine, ProtoSession } from './mock-data';
import { formatGb, formatVcpu, machineTotals } from './model';
import {
  AdvancedLinks,
  EmptyMachineNote,
  MachineHeading,
  SessionMeta,
  SessionStateIcon,
  SessionTitle,
} from './shared';

type Metric = 'memory' | 'cpu';

const pick = (s: ProtoSession, metric: Metric) =>
  metric === 'memory' ? s.memorySeries : s.cpuSeries;
const reservedOf = (s: ProtoSession, metric: Metric) =>
  metric === 'memory' ? s.reserved.memoryMb : s.reserved.cpuMillis;
const usedOf = (s: ProtoSession, metric: Metric) =>
  metric === 'memory' ? s.used.memoryMb : s.used.cpuMillis;
const fmt = (v: number, metric: Metric) => (metric === 'memory' ? formatGb(v) : formatVcpu(v));

function linePoints(points: number[], max: number): string {
  const n = points.length - 1;
  return points.map((p, i) => `${(i / n) * 100},${100 - (p / max) * 100}`).join(' ');
}

function MachineChart({ machine, metric }: { machine: ProtoMachine; metric: Metric }) {
  const t = machineTotals(machine);
  const capacity = metric === 'memory' ? t.cap.memoryMb : t.cap.cpuMillis;
  const reserved = t.exclusive ? capacity : metric === 'memory' ? t.reservedMem : t.reservedCpu;
  const used = metric === 'memory' ? t.usedMem : t.usedCpu;
  // One total line: five stacked bands read as a striped ribbon, and the per-session
  // story lives in each row's own sparkline below.
  const total = Array.from({ length: 30 }, (_, i) =>
    machine.sessions.reduce((acc, s) => acc + (pick(s, metric)[i] ?? 0), 0)
  );
  const line = linePoints(total, capacity);
  const reservedY = 100 - Math.min(1, reserved / capacity) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`relative ${machine.sessions.length === 0 ? 'h-12' : 'h-[92px] md:h-[112px]'}`}
      >
        <div className="sam-well absolute inset-0 overflow-hidden rounded-[12px]">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            {machine.sessions.length > 0 && (
              <>
                <polygon
                  points={`0,100 ${line} 100,100`}
                  fill="var(--sam-color-accent-primary)"
                  fillOpacity={0.45}
                />
                <polyline
                  points={line}
                  fill="none"
                  stroke="var(--sam-status-success-fg)"
                  strokeWidth={1.75}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            <line
              x1="0"
              x2="100"
              y1={reservedY}
              y2={reservedY}
              stroke="var(--sam-color-fg-muted)"
              strokeDasharray="4 3"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {machine.sessions.length === 0 && (
            <div className="absolute inset-0 grid place-items-center text-[12px] text-fg-muted">
              Nothing ran here in the last 30 minutes
            </div>
          )}
        </div>
        {machine.sessions.length > 0 && (
          <span
            className="absolute right-2 -translate-y-full rounded-md bg-[var(--sam-chip-bg)] px-1.5 font-mono text-[10.5px] text-fg-muted"
            style={{ top: `${Math.max(16, reservedY)}%` }}
          >
            set aside {fmt(reserved, metric)}
          </span>
        )}
      </div>
      {machine.sessions.length > 0 && (
        <div className="flex justify-between font-mono text-[10.5px] text-fg-muted">
          <span>30 min ago</span>
          <span>
            now <span className="text-fg-primary">{fmt(used, metric)}</span> of{' '}
            {fmt(capacity, metric)}
          </span>
        </div>
      )}
    </div>
  );
}

function Sparkline({ session, metric }: { session: ProtoSession; metric: Metric }) {
  const points = pick(session, metric);
  const reserved = reservedOf(session, metric);
  const max = Math.max(reserved, ...points) * 1.08;
  const n = points.length - 1;
  const line = points.map((p, i) => `${(i / n) * 100},${100 - (p / max) * 100}`).join(' ');
  const over = usedOf(session, metric) > reserved;
  const danger = over && metric === 'memory';
  const stroke = danger ? 'var(--sam-status-danger-fg)' : 'var(--sam-status-success-fg)';
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-7 w-full min-w-0 md:h-8 md:w-[140px] md:shrink-0"
      aria-hidden="true"
    >
      <polygon points={`0,100 ${line} 100,100`} fill={stroke} fillOpacity={0.16} />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="0"
        x2="100"
        y1={100 - (reserved / max) * 100}
        y2={100 - (reserved / max) * 100}
        stroke="var(--sam-color-fg-muted)"
        strokeDasharray="3 2"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SessionRow({ session, metric }: { session: ProtoSession; metric: Metric }) {
  const reserved = reservedOf(session, metric);
  const used = usedOf(session, metric);
  const over = used > reserved;
  const note = over ? (metric === 'memory' ? 'over limit' : 'bursting, fine') : null;
  const value = (
    <div className="w-[76px] shrink-0 text-right font-mono text-[11.5px] leading-tight md:w-[96px]">
      <div
        className={
          over && metric === 'memory' ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-primary'
        }
      >
        {fmt(used, metric)}
      </div>
      <div
        className={
          over && metric === 'memory' ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-muted'
        }
      >
        {note ?? `of ${fmt(reserved, metric)}`}
      </div>
    </div>
  );
  return (
    <li className="flex min-h-[56px] items-start gap-2.5 py-2.5 md:items-center">
      <span className="mt-0.5 md:mt-0">
        <SessionStateIcon state={session.state} size={15} />
      </span>
      {/* Phone: title, meta, then a full-width sparkline with the value. Desktop: one row. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-center md:gap-2.5">
        <a href={`#chat-${session.id}`} className="min-w-0 flex-1 no-underline">
          <SessionTitle session={session} />
          <SessionMeta session={session} />
        </a>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex min-w-0 flex-1 md:flex-none">
            <Sparkline session={session} metric={metric} />
          </span>
          {value}
        </div>
      </div>
    </li>
  );
}

export function ConceptLive({ machines }: { machines: ProtoMachine[] }) {
  const [metric, setMetric] = useState<Metric>('memory');
  return (
    <div className="flex flex-col gap-[var(--sam-space-gutter)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="m-0 min-w-0 flex-1 basis-[240px] text-[12.5px] text-fg-muted">
          The last 30 minutes. Green is what sessions used; the dashed line is what SAM set aside
          for them.
        </p>
        <SegmentedControl
          label="Resource"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'memory', label: 'Memory' },
            { value: 'cpu', label: 'CPU' },
          ]}
          className="w-[180px]"
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] 2xl:grid-cols-2">
        {machines.map((m) => (
          <Pane key={m.id} className="flex min-w-0 flex-col gap-3 p-4">
            <MachineHeading machine={m} />
            {m.state === 'starting' ? (
              <EmptyMachineNote machine={m} />
            ) : (
              <MachineChart machine={m} metric={metric} />
            )}
            {m.sessions.length === 0 && m.state !== 'starting' && <EmptyMachineNote machine={m} />}
            {m.sessions.length > 0 && (
              <ul className="m-0 flex list-none flex-col divide-y divide-[var(--sam-hairline)] p-0">
                {m.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} metric={metric} />
                ))}
              </ul>
            )}
            {m.sessions.length > 0 && <AdvancedLinks machine={m} sessions={m.sessions} />}
          </Pane>
        ))}
      </div>
    </div>
  );
}
