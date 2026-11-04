// PROTOTYPE ONLY — Concept 1, "Fill levels".
//
// Each machine is a glass well. Each session is a glass standing in it: its width is the
// memory SAM set aside for it, and the liquid inside is the memory it is using now.
// Memory is the dimension that breaks (CPU only slows down), so it gets the picture;
// CPU is a number in the row. A glass that overflows is the OOM risk.
import { Pane } from '@simple-agent-manager/ui';
import { useState } from 'react';

import type { ProtoMachine, ProtoSession } from './mock-data';
import {
  formatGb,
  formatGbBare,
  formatVcpu,
  machineCapacity,
  machineTotals,
  memoryPressure,
  roomFor,
} from './model';
import {
  AdvancedLinks,
  EmptyMachineNote,
  MachineHeading,
  SessionMeta,
  SessionStateIcon,
  SessionTitle,
} from './shared';

function Glass({
  session,
  index,
  widthPct,
  active,
  onHover,
}: {
  session: ProtoSession;
  index: number;
  widthPct: number;
  active: boolean;
  onHover: (id: string | null) => void;
}) {
  const ratio = session.used.memoryMb / session.reserved.memoryMb;
  const pressure = memoryPressure(session);
  const fill = Math.min(1, ratio);
  const liquid =
    pressure === 'over'
      ? 'bg-[linear-gradient(180deg,var(--sam-status-danger-fg),var(--sam-color-danger))]'
      : 'bg-[linear-gradient(180deg,var(--sam-status-success-fg),var(--sam-color-accent-primary))]';
  return (
    <button
      type="button"
      onMouseEnter={() => onHover(session.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(session.id)}
      onBlur={() => onHover(null)}
      aria-label={`${session.title}: using ${formatGb(session.used.memoryMb)} of ${formatGb(session.reserved.memoryMb)} set aside`}
      className={`relative h-full min-w-[22px] cursor-pointer overflow-visible rounded-[9px] border p-0 transition-[box-shadow,border-color] ${
        active
          ? 'border-[var(--sam-status-success-fg)] shadow-[var(--sam-shadow-glow-active)]'
          : 'border-[var(--sam-chip-edge)]'
      } bg-[var(--sam-chip-bg)]`}
      style={{ flex: `${widthPct} 1 0%` }}
    >
      {/* Liquid: memory in use against memory set aside */}
      <span
        aria-hidden="true"
        className={`absolute inset-x-[3px] bottom-[3px] rounded-[6px] opacity-90 ${liquid}`}
        style={{ height: `calc(${fill * 100}% - 6px)` }}
      />
      {/* Peak line: the highest memory this session has reached */}
      <span
        aria-hidden="true"
        className="absolute inset-x-[3px] border-t border-dashed border-[var(--sam-color-fg-muted)]"
        style={{
          bottom: `calc(${Math.min(1, session.peakMemoryMb / session.reserved.memoryMb) * 100}% - 3px)`,
        }}
      />
      {pressure === 'over' && (
        <span
          aria-hidden="true"
          className="absolute -top-[7px] left-1/2 h-[7px] w-[60%] -translate-x-1/2 rounded-t-full bg-[var(--sam-status-danger-fg)]"
        />
      )}
      <span className="absolute top-1.5 left-1/2 grid h-[18px] min-w-[18px] -translate-x-1/2 place-items-center rounded-full bg-[var(--sam-chip-bg)] px-1 font-mono text-[10.5px] font-semibold text-fg-primary shadow-[0_0_0_1px_var(--sam-chip-edge)]">
        {index + 1}
      </span>
    </button>
  );
}

function MachineWell({
  machine,
  active,
  onHover,
}: {
  machine: ProtoMachine;
  active: string | null;
  onHover: (id: string | null) => void;
}) {
  const t = machineTotals(machine);
  const cap = machineCapacity(machine);
  const freePct = t.exclusive ? 0 : Math.max(0, 100 - t.reservedMemShare * 100);
  const room = roomFor(machine);
  return (
    <div
      className={`sam-well flex gap-[5px] rounded-[14px] p-[5px] ${
        machine.sessions.length === 0 ? 'h-14' : 'h-[136px] md:h-[156px]'
      }`}
    >
      {machine.sessions.map((s, i) => (
        <Glass
          key={s.id}
          session={s}
          index={i}
          widthPct={t.exclusive ? 100 : (s.reserved.memoryMb / cap.memoryMb) * 100}
          active={active === s.id}
          onHover={onHover}
        />
      ))}
      {freePct > 0 && (
        <div
          className="grid min-w-0 place-items-center rounded-[9px] border border-dashed border-[var(--sam-chip-edge)] px-1 text-center text-[11.5px] text-fg-muted"
          style={{ flex: `${freePct} 1 0%` }}
        >
          {machine.state === 'starting'
            ? 'Starting…'
            : room === 0
              ? 'Full'
              : `Room for ${room} more`}
        </div>
      )}
    </div>
  );
}

function SessionLine({
  session,
  index,
  active,
  onHover,
}: {
  session: ProtoSession;
  index: number;
  active: boolean;
  onHover: (id: string | null) => void;
}) {
  const pressure = memoryPressure(session);
  return (
    <li
      onMouseEnter={() => onHover(session.id)}
      onMouseLeave={() => onHover(null)}
      className={`flex min-h-[52px] items-center gap-2.5 rounded-[11px] px-2 py-1.5 ${active ? 'bg-[var(--sam-glass-v2-raised)]' : ''}`}
    >
      <span className="w-4 shrink-0 text-center font-mono text-[11px] font-semibold text-fg-muted">
        {index + 1}
      </span>
      <SessionStateIcon state={session.state} size={15} />
      <a href={`#chat-${session.id}`} className="min-w-0 flex-1 no-underline">
        <SessionTitle session={session} />
        <SessionMeta session={session} />
      </a>
      <div className="shrink-0 text-right font-mono text-[11.5px] leading-tight">
        <div
          className={pressure === 'over' ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-primary'}
        >
          {formatGbBare(session.used.memoryMb)}/{formatGb(session.reserved.memoryMb)}
        </div>
        <div className="text-fg-muted">{formatVcpu(session.used.cpuMillis)}</div>
      </div>
    </li>
  );
}

function MachinePane({ machine }: { machine: ProtoMachine }) {
  const [active, setActive] = useState<string | null>(null);
  const t = machineTotals(machine);
  return (
    <Pane className="flex min-w-0 flex-col gap-3 p-4">
      <MachineHeading machine={machine} />
      <MachineWell machine={machine} active={active} onHover={setActive} />
      {machine.sessions.length === 0 ? (
        <EmptyMachineNote machine={machine} />
      ) : (
        <p className="m-0 text-[12.5px] text-fg-muted">
          {t.exclusive ? (
            <>
              Set aside whole for one session, which is using {formatGb(t.usedMem)} of{' '}
              {formatGb(t.cap.memoryMb)}.
            </>
          ) : (
            <>
              <span className="text-fg-primary">{formatGb(t.usedMem)}</span> in use of{' '}
              {formatGb(t.reservedMem)} set aside · {formatGb(t.cap.memoryMb)} on the machine
            </>
          )}
        </p>
      )}
      {machine.sessions.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {machine.sessions.map((s, i) => (
            <SessionLine
              key={s.id}
              session={s}
              index={i}
              active={active === s.id}
              onHover={setActive}
            />
          ))}
        </ul>
      )}
      {machine.sessions.length > 0 && (
        <AdvancedLinks machine={machine} sessions={machine.sessions} />
      )}
    </Pane>
  );
}

export function ConceptFill({ machines }: { machines: ProtoMachine[] }) {
  return (
    <div className="flex flex-col gap-[var(--sam-space-gutter)]">
      <p className="m-0 px-1 text-[12.5px] text-fg-muted">
        Each glass is a session. Its width is the memory SAM set aside for it; the fill is what it
        is using now, the dashed line its highest so far. A glass that spills over is close to being
        stopped for running out of memory.
      </p>
      <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] xl:grid-cols-2">
        {machines.map((m) => (
          <MachinePane key={m.id} machine={m} />
        ))}
      </div>
    </div>
  );
}
