// PROTOTYPE ONLY — Concept 2b, "Live: CPU + memory together".
//
// A mirrored chart: memory rises above a centre line, CPU hangs below it, each scaled to
// the machine and each with its own dashed "set aside" line. The same mirror is repeated
// small on every session row, so both resources read at once without a toggle. Memory is
// green and CPU is blue (the pair validated for colour-blind separation on the dark
// surface); position says which is which even without colour.
import { Pane } from '@simple-agent-manager/ui';

import type { ProtoMachine, ProtoSession } from './mock-data';
import { formatGb, formatGbBare, formatVcpu, formatVcpuBare, machineTotals } from './model';
import {
  AdvancedLinks,
  EmptyMachineNote,
  MachineHeading,
  SessionMeta,
  SessionStateIcon,
  SessionTitle,
} from './shared';

const MEM = 'var(--sam-status-success-fg)';
const MEM_FILL = 'var(--sam-color-accent-primary)';
const CPU = 'var(--sam-status-info-fg)';
const DANGER = 'var(--sam-status-danger-fg)';
/** Each half leaves a little headroom so a full machine still shows its edge. */
const HALF = 47;

/** Points for one half of the mirror: `up` draws above the centre line, otherwise below. */
function half(points: number[], max: number, up: boolean): string {
  const n = points.length - 1;
  return points
    .map((p, i) => {
      const h = (Math.min(p, max) / max) * HALF;
      return `${(i / n) * 100},${up ? 50 - h : 50 + h}`;
    })
    .join(' ');
}

function yFor(value: number, max: number, up: boolean): number {
  const h = (Math.min(value, max) / max) * HALF;
  return up ? 50 - h : 50 + h;
}

function Mirror({
  memory,
  cpu,
  memMax,
  cpuMax,
  memReserved,
  cpuReserved,
  memDanger = false,
  className,
}: {
  memory: number[];
  cpu: number[];
  memMax: number;
  cpuMax: number;
  memReserved: number;
  cpuReserved: number;
  memDanger?: boolean;
  className: string;
}) {
  const memLine = half(memory, memMax, true);
  const cpuLine = half(cpu, cpuMax, false);
  const memStroke = memDanger ? DANGER : MEM;
  const memReservedY = yFor(memReserved, memMax, true);
  const cpuReservedY = yFor(cpuReserved, cpuMax, false);
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className} aria-hidden="true">
      <polygon
        points={`0,50 ${memLine} 100,50`}
        fill={memDanger ? DANGER : MEM_FILL}
        fillOpacity={0.4}
      />
      <polyline
        points={memLine}
        fill="none"
        stroke={memStroke}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={`0,50 ${cpuLine} 100,50`} fill={CPU} fillOpacity={0.28} />
      <polyline
        points={cpuLine}
        fill="none"
        stroke={CPU}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="0"
        x2="100"
        y1="50"
        y2="50"
        stroke="var(--sam-chip-edge)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="0"
        x2="100"
        y1={memReservedY}
        y2={memReservedY}
        stroke="var(--sam-color-fg-muted)"
        strokeDasharray="4 3"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="0"
        x2="100"
        y1={cpuReservedY}
        y2={cpuReservedY}
        stroke="var(--sam-color-fg-muted)"
        strokeDasharray="4 3"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

function MachineChart({ machine }: { machine: ProtoMachine }) {
  const t = machineTotals(machine);
  const memReserved = t.exclusive ? t.cap.memoryMb : t.reservedMem;
  const cpuReserved = t.exclusive ? t.cap.cpuMillis : t.reservedCpu;
  const sumAt = (pick: (s: ProtoSession) => number[]) =>
    Array.from({ length: 30 }, (_, i) =>
      machine.sessions.reduce((acc, s) => acc + (pick(s)[i] ?? 0), 0)
    );
  if (machine.sessions.length === 0) {
    return (
      <div className="sam-well grid h-12 place-items-center rounded-[12px] text-[12px] text-fg-muted">
        Nothing ran here in the last 30 minutes
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {/* Labels live outside the chart: inside it they sat on the lines of a full machine. */}
      <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
        <span className="flex min-w-0 items-center gap-1.5 text-fg-primary">
          <Swatch color={MEM} />
          memory {formatGb(t.usedMem)}
          <span className="text-fg-muted">of {formatGb(t.cap.memoryMb)}</span>
        </span>
        <span className="shrink-0 text-fg-muted">set aside {formatGb(memReserved)}</span>
      </div>
      <div className="sam-well relative h-[120px] overflow-hidden rounded-[12px] md:h-[150px]">
        <Mirror
          memory={sumAt((s) => s.memorySeries)}
          cpu={sumAt((s) => s.cpuSeries)}
          memMax={t.cap.memoryMb}
          cpuMax={t.cap.cpuMillis}
          memReserved={memReserved}
          cpuReserved={cpuReserved}
          className="absolute inset-0 h-full w-full"
        />
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
        <span className="flex min-w-0 items-center gap-1.5 text-fg-primary">
          <Swatch color={CPU} />
          cpu {formatVcpuBare(t.usedCpu)}
          <span className="text-fg-muted">of {formatVcpu(t.cap.cpuMillis)}</span>
        </span>
        <span className="shrink-0 text-fg-muted">set aside {formatVcpu(cpuReserved)}</span>
      </div>
      <div className="flex justify-between font-mono text-[10px] text-fg-muted">
        <span>30 min ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: ProtoSession }) {
  const memOver = session.used.memoryMb > session.reserved.memoryMb;
  const cpuOver = session.used.cpuMillis > session.reserved.cpuMillis;
  const memMax = Math.max(session.reserved.memoryMb, ...session.memorySeries) * 1.08;
  const cpuMax = Math.max(session.reserved.cpuMillis, ...session.cpuSeries) * 1.08;
  return (
    <li className="flex min-h-[56px] items-start gap-2.5 py-2.5 md:items-center">
      <span className="mt-0.5 md:mt-0">
        <SessionStateIcon state={session.state} size={15} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
        <a href={`#chat-${session.id}`} className="min-w-0 flex-1 no-underline">
          <SessionTitle session={session} />
          <SessionMeta session={session} />
        </a>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex min-w-0 flex-1 md:flex-none">
            <Mirror
              memory={session.memorySeries}
              cpu={session.cpuSeries}
              memMax={memMax}
              cpuMax={cpuMax}
              memReserved={session.reserved.memoryMb}
              cpuReserved={session.reserved.cpuMillis}
              memDanger={memOver}
              className="h-10 w-full min-w-0 md:w-[150px] md:shrink-0"
            />
          </span>
          <div className="w-[104px] shrink-0 font-mono text-[11px] leading-[1.35]">
            <div className="flex items-center justify-end gap-1.5">
              <span className={memOver ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-primary'}>
                {formatGbBare(session.used.memoryMb)}
                <span className={memOver ? '' : 'text-fg-muted'}>
                  /{formatGb(session.reserved.memoryMb)}
                </span>
              </span>
              <Swatch color={memOver ? DANGER : MEM} />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-fg-primary">
                {formatVcpuBare(session.used.cpuMillis)}
                <span className="text-fg-muted">/{formatVcpu(session.reserved.cpuMillis)}</span>
              </span>
              <Swatch color={CPU} />
            </div>
            {(memOver || cpuOver) && (
              <div
                className={`text-right ${memOver ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-muted'}`}
              >
                {memOver ? 'over limit' : 'burst, fine'}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function ConceptLiveBoth({ machines }: { machines: ProtoMachine[] }) {
  return (
    <div className="flex flex-col gap-[var(--sam-space-gutter)]">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12.5px] text-fg-muted">
        <span>Last 30 minutes.</span>
        <span className="flex items-center gap-1.5">
          <Swatch color={MEM} /> Memory goes up
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch color={CPU} /> CPU goes down
        </span>
        <span>Dashed: what SAM set aside.</span>
      </p>
      <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] 2xl:grid-cols-2">
        {machines.map((m) => (
          <Pane key={m.id} className="flex min-w-0 flex-col gap-3 p-4">
            <MachineHeading machine={m} />
            {m.state === 'starting' ? (
              <EmptyMachineNote machine={m} />
            ) : (
              <MachineChart machine={m} />
            )}
            {m.sessions.length === 0 && m.state !== 'starting' && <EmptyMachineNote machine={m} />}
            {m.sessions.length > 0 && (
              <ul className="m-0 flex list-none flex-col divide-y divide-[var(--sam-hairline)] p-0">
                {m.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} />
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
