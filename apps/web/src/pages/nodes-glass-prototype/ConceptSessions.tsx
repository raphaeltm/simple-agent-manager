// PROTOTYPE ONLY — Concept 3, "Sessions first".
//
// The page is about the chats, not the machines. Every running session is a row you can
// open, like the chat list, grouped under the machine it runs on. Each row has a
// footprint: the outline is what SAM set aside, the fill is what it is using. Machines
// shrink to a side pane (a strip on a phone) that answers "how full is each one".
import { Pane, PaneSeparator, personColorVar, SegmentedControl } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { ProtoMachine, ProtoSession } from './mock-data';
import { formatGb, formatGbBare, formatVcpu, formatVcpuBare, machineTotals, pct } from './model';
import {
  MachineStateChip,
  SessionMeta,
  SessionStateIcon,
  SessionTitle,
  WorkspaceLink,
} from './shared';

type Scope = 'mine' | 'others' | 'all';

function Footprint({
  label,
  used,
  reserved,
  kind,
}: {
  label: string;
  used: number;
  reserved: number;
  kind: 'memory' | 'cpu';
}) {
  const ratio = used / reserved;
  const over = ratio > 1;
  const fill = Math.min(1, ratio);
  const danger = over && kind === 'memory';
  const text =
    kind === 'memory'
      ? `${formatGbBare(used)}/${formatGb(reserved)}`
      : `${formatVcpuBare(used)}/${formatVcpu(reserved)}`;
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${text}`}>
      <span className="w-7 font-mono text-[10px] text-fg-muted">{label}</span>
      <span className="relative h-[7px] w-[54px] rounded-full border border-[var(--sam-chip-edge)] md:w-[72px]">
        <span
          aria-hidden="true"
          className={`absolute inset-y-[1px] left-[1px] rounded-full ${danger ? 'bg-[var(--sam-status-danger-fg)]' : 'bg-[var(--sam-status-success-fg)]'}`}
          style={{ width: `calc(${fill * 100}% - 2px)` }}
        />
        {over && (
          <span
            aria-hidden="true"
            className={`absolute -top-[1px] -right-[5px] h-[7px] w-[5px] rounded-r-full ${danger ? 'bg-[var(--sam-status-danger-fg)]' : 'bg-[var(--sam-status-success-fg)] opacity-60'}`}
          />
        )}
      </span>
      <span
        className={`hidden w-[92px] whitespace-nowrap font-mono text-[10.5px] md:inline ${danger ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-muted'}`}
      >
        {text}
      </span>
    </div>
  );
}

function Row({ session }: { session: ProtoSession }) {
  const someoneElse = session.owner.slot !== 'you';
  return (
    <li className="relative">
      {someoneElse && (
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full"
          style={{
            background: personColorVar(session.owner.slot),
            boxShadow: `0 0 8px ${personColorVar(session.owner.slot)}`,
          }}
        />
      )}
      <a
        href={`#chat-${session.id}`}
        className="flex min-h-[60px] items-center gap-3 rounded-[12px] px-3 py-2 no-underline hover:bg-[var(--sam-glass-v2-raised)]"
      >
        <SessionStateIcon state={session.state} />
        <div className="min-w-0 flex-1">
          <SessionTitle session={session} />
          <SessionMeta session={session} />
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Footprint
            label="MEM"
            kind="memory"
            used={session.used.memoryMb}
            reserved={session.reserved.memoryMb}
          />
          <Footprint
            label="CPU"
            kind="cpu"
            used={session.used.cpuMillis}
            reserved={session.reserved.cpuMillis}
          />
        </div>
        <ChevronRight
          size={16}
          className="hidden shrink-0 text-fg-muted md:block"
          aria-hidden="true"
        />
      </a>
    </li>
  );
}

/** A ring: the outer arc is what is set aside, the inner fill is what is in use. */
function Ring({ machine, size = 40 }: { machine: ProtoMachine; size?: number }) {
  const t = machineTotals(machine);
  const reserved = Math.min(1, t.reservedMemShare) * 360;
  const used = Math.min(1, t.usedMemShare) * 360;
  return (
    <span
      aria-hidden="true"
      className="relative grid shrink-0 place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(var(--sam-status-success-fg) 0deg ${used}deg, color-mix(in srgb, var(--sam-status-success-fg) 30%, transparent) ${used}deg ${reserved}deg, var(--sam-chip-edge) ${reserved}deg 360deg)`,
      }}
    >
      <span className="grid h-[calc(100%-8px)] w-[calc(100%-8px)] place-items-center rounded-full bg-[var(--sam-chip-bg)] font-mono text-[10px] text-fg-primary">
        {machine.state === 'starting' ? '…' : pct(t.reservedMemShare)}
      </span>
    </span>
  );
}

function MachineChip({ machine }: { machine: ProtoMachine }) {
  const t = machineTotals(machine);
  return (
    <a
      href={`#node-${machine.id}`}
      className="sam-raised flex min-h-[60px] min-w-[210px] items-center gap-3 rounded-[14px] px-3 py-2 no-underline md:min-w-0"
    >
      <Ring machine={machine} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-fg-primary">
          {machine.instanceType} · {machine.location}
        </div>
        <div className="truncate text-[11.5px] text-fg-muted">
          {machine.sessions.length === 0
            ? machine.state === 'warm'
              ? `Warm, goes away in ${machine.warmMinutesLeft}m`
              : 'Starting'
            : `${machine.sessions.length} session${machine.sessions.length === 1 ? '' : 's'} · ${formatGb(t.usedMem)} in use`}
        </div>
      </div>
    </a>
  );
}

export function ConceptSessions({ machines }: { machines: ProtoMachine[] }) {
  const [scope, setScope] = useState<Scope>('all');
  const all = machines.flatMap((m) => m.sessions);
  const counts = {
    mine: all.filter((s) => s.owner.slot === 'you').length,
    others: all.filter((s) => s.owner.slot !== 'you').length,
    all: all.length,
  };
  const groups = useMemo(
    () =>
      machines
        .map((m) => ({
          machine: m,
          sessions: m.sessions.filter((s) =>
            scope === 'all'
              ? true
              : scope === 'mine'
                ? s.owner.slot === 'you'
                : s.owner.slot !== 'you'
          ),
        }))
        .filter((g) => g.sessions.length > 0),
    [machines, scope]
  );

  return (
    <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] lg:grid-cols-[minmax(0,1fr)_300px]">
      {/* On a phone the machines come first as a strip; on desktop they are the side pane. */}
      <Pane className="order-1 flex min-w-0 flex-col gap-2 p-3 lg:order-2 lg:p-4">
        <div className="flex items-baseline justify-between px-1">
          <h3 className="m-0 text-[13px] font-semibold text-fg-primary">Machines</h3>
          <span className="text-[11.5px] text-fg-muted">ring: memory set aside</span>
        </div>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:flex-col lg:overflow-visible">
          {machines.map((m) => (
            <MachineChip key={m.id} machine={m} />
          ))}
        </div>
      </Pane>

      <Pane className="order-2 flex min-w-0 flex-col gap-1 p-2 lg:order-1 lg:p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1 pb-2">
          <h3 className="m-0 text-[13px] font-semibold text-fg-primary">Running now</h3>
          <SegmentedControl
            label="Whose sessions"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: 'Mine', count: counts.mine },
              { value: 'others', label: 'Others', count: counts.others },
              { value: 'all', label: 'All', count: counts.all },
            ]}
            className="w-[240px]"
          />
        </div>
        {groups.map((g, gi) => {
          const t = machineTotals(g.machine);
          return (
            <section
              key={g.machine.id}
              aria-label={`${g.machine.instanceType} in ${g.machine.location}`}
            >
              {gi > 0 && <PaneSeparator className="mx-2 my-1" />}
              <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1">
                <span className="min-w-0 truncate font-mono text-[11px] uppercase tracking-wide text-fg-muted">
                  {g.machine.instanceType} · {g.machine.location}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-muted">
                  {t.exclusive ? 'whole machine' : `${pct(t.reservedMemShare)} set aside`}
                </span>
                {/* Only say the state when it is not the normal one. */}
                {g.machine.state !== 'running' && <MachineStateChip machine={g.machine} />}
              </div>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.sessions.map((s) => (
                  <Row key={s.id} session={s} />
                ))}
              </ul>
            </section>
          );
        })}
        <details className="px-3 pt-2 pb-1 text-[11.5px] text-fg-muted">
          <summary className="cursor-pointer select-none">Advanced: workspaces</summary>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {all.map((s) => (
              <WorkspaceLink key={s.id} session={s} />
            ))}
          </div>
        </details>
      </Pane>
    </div>
  );
}
