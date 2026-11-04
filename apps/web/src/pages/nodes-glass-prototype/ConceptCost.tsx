// PROTOTYPE ONLY — Concept 4, "Cost".
//
// The money view. Each machine's hourly price is split into what each session holds
// (its share of the machine) and the part nobody holds. Inside each session's share, the
// solid part is what it actually uses. Prices are examples, not live provider prices.
import { Button, Pane } from '@simple-agent-manager/ui';
import { Lightbulb } from 'lucide-react';

import type { ProtoMachine, ProtoSession } from './mock-data';
import { formatEur, formatGb, sessionShare } from './model';
import {
  EmptyMachineNote,
  MachineHeading,
  SessionMeta,
  SessionStateIcon,
  SessionTitle,
} from './shared';

const HOURS_PER_MONTH = 730;
const HATCH = 'repeating-linear-gradient(135deg, var(--sam-chip-edge) 0 2px, transparent 2px 7px)';

function sessionCost(m: ProtoMachine, s: ProtoSession) {
  const share = Math.min(1, sessionShare(m, s));
  const perHour = share * m.hourlyEur;
  return { share, perHour, soFar: (perHour * s.startedMinutesAgo) / 60 };
}

function unclaimedShare(m: ProtoMachine): number {
  if (m.sessions.length === 0) return 1;
  return Math.max(0, 1 - m.sessions.reduce((t, s) => t + Math.min(1, sessionShare(m, s)), 0));
}

function hint(m: ProtoMachine, s: ProtoSession): string | null {
  if (s.reserved.exclusiveNode && s.state === 'idle') {
    return `Idle on a machine of its own for ${Math.floor(s.startedMinutesAgo / 60)}h. Sleeping it frees ${formatEur(m.hourlyEur)}/h.`;
  }
  const peakRatio = s.peakMemoryMb / s.reserved.memoryMb;
  if (s.startedMinutesAgo >= 60 && peakRatio < 0.75) {
    return `Never above ${formatGb(s.peakMemoryMb)} of the ${formatGb(s.reserved.memoryMb)} it asked for. A smaller request leaves room for others.`;
  }
  return null;
}

function CostBar({ machine }: { machine: ProtoMachine }) {
  const free = unclaimedShare(machine);
  return (
    <div className="sam-well flex h-9 gap-[3px] rounded-[11px] p-[3px]" aria-hidden="true">
      {machine.sessions.map((s) => {
        const { share } = sessionCost(machine, s);
        const usedRatio = Math.min(1, s.used.memoryMb / s.reserved.memoryMb);
        return (
          <span
            key={s.id}
            className="relative min-w-[6px] overflow-hidden rounded-[8px] bg-[color-mix(in_srgb,var(--sam-status-success-fg)_22%,var(--sam-chip-bg))]"
            style={{ flex: `${share} 1 0%` }}
          >
            <span
              className="absolute inset-y-0 left-0 bg-[var(--sam-color-accent-primary)]"
              style={{ width: `${usedRatio * 100}%` }}
            />
          </span>
        );
      })}
      {free > 0.005 && (
        <span className="rounded-[8px]" style={{ flex: `${free} 1 0%`, background: HATCH }} />
      )}
    </div>
  );
}

function MachinePane({ machine }: { machine: ProtoMachine }) {
  const free = unclaimedShare(machine);
  return (
    <Pane className="flex min-w-0 flex-col gap-3 p-4">
      <MachineHeading
        machine={machine}
        trailing={
          <span className="font-mono text-[13px] font-semibold text-fg-primary">
            {formatEur(machine.hourlyEur)}/h
          </span>
        }
      />
      {machine.state !== 'starting' && <CostBar machine={machine} />}
      {machine.sessions.length === 0 ? (
        <EmptyMachineNote machine={machine} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-[var(--sam-hairline)] p-0">
          {machine.sessions.map((s) => {
            const c = sessionCost(machine, s);
            const h = hint(machine, s);
            return (
              <li key={s.id} className="flex flex-col gap-1.5 py-2">
                <div className="flex min-h-[44px] items-center gap-2.5">
                  <SessionStateIcon state={s.state} size={15} />
                  <a href={`#chat-${s.id}`} className="min-w-0 flex-1 no-underline">
                    <SessionTitle session={s} />
                    <SessionMeta session={s} />
                  </a>
                  <div className="shrink-0 text-right font-mono text-[11.5px] leading-tight">
                    <div className="text-fg-primary">{formatEur(c.perHour)}/h</div>
                    <div className="text-fg-muted">{formatEur(c.soFar)} so far</div>
                  </div>
                </div>
                {h && (
                  <div className="ml-[25px] flex items-start gap-2 rounded-[10px] bg-[var(--sam-chip-bg)] px-2.5 py-2 text-[12px] text-fg-muted">
                    <Lightbulb
                      size={14}
                      className="mt-[1px] shrink-0 text-fg-muted"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">{h}</span>
                    {s.reserved.exclusiveNode && (
                      <Button size="sm" variant="secondary">
                        Sleep
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {machine.sessions.length > 0 && free > 0.005 && (
        <p className="m-0 flex items-center gap-2 text-[12px] text-fg-muted">
          <span
            aria-hidden="true"
            className="inline-block h-3 w-5 rounded-[4px]"
            style={{ background: HATCH }}
          />
          {formatEur(free * machine.hourlyEur)}/h held by nobody: room for more sessions
        </p>
      )}
    </Pane>
  );
}

export function ConceptCost({ machines }: { machines: ProtoMachine[] }) {
  const total = machines.reduce((t, m) => t + m.hourlyEur, 0);
  // A machine that is still starting has not had a chance to be used yet; leave it out
  // of the "unused" figures rather than calling it waste.
  const settled = machines.filter((m) => m.state !== 'starting');
  let inUse = 0;
  let heldUnused = 0;
  let unclaimed = 0;
  for (const m of settled) {
    unclaimed += unclaimedShare(m) * m.hourlyEur;
    for (const s of m.sessions) {
      const c = sessionCost(m, s);
      const usedRatio = Math.min(1, s.used.memoryMb / s.reserved.memoryMb);
      inUse += c.perHour * usedRatio;
      heldUnused += c.perHour * (1 - usedRatio);
    }
  }
  const starting = total - inUse - heldUnused - unclaimed;
  const sessions = machines.reduce((t, m) => t + m.sessions.length, 0);
  const parts = [
    {
      key: 'use',
      label: 'In use',
      value: inUse,
      style: { background: 'var(--sam-color-accent-primary)' },
    },
    {
      key: 'held',
      label: 'Set aside, not used',
      value: heldUnused,
      style: {
        background: 'color-mix(in srgb, var(--sam-status-success-fg) 22%, var(--sam-chip-bg))',
      },
    },
    { key: 'free', label: 'Nobody on it', value: unclaimed, style: { background: HATCH } },
    {
      key: 'starting',
      label: 'Starting up',
      value: starting,
      // Info blue, matching the Starting chip, so it is not mistaken for set-aside memory.
      style: {
        background: 'color-mix(in srgb, var(--sam-status-info-fg) 45%, var(--sam-chip-bg))',
      },
    },
  ].filter((p) => p.value > 0.0005);
  return (
    <div className="flex flex-col gap-[var(--sam-space-gutter)]">
      <Pane className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="shrink-0">
          <p className="m-0 text-[12.5px] text-fg-muted">Running right now</p>
          <p className="m-0 mt-1 font-mono text-[28px] font-bold text-fg-primary">
            {formatEur(total, 3)}
            <span className="text-[15px] font-medium text-fg-muted"> / hour</span>
          </p>
          <p className="m-0 mt-1 text-[12.5px] text-fg-muted">
            {machines.length} machines, {sessions} sessions. About{' '}
            {formatEur(total * HOURS_PER_MONTH, 0)} a month if everything stays on.
          </p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 md:max-w-[460px]">
          <div className="sam-well flex h-6 gap-[3px] rounded-full p-[3px]" aria-hidden="true">
            {/* Weights are normalised to 100: flex-grow values that sum below 1 fill only
                that fraction of the track, which left this bar a fifth full. */}
            {parts.map((p) => (
              <span
                key={p.key}
                className="rounded-full"
                style={{ flex: `${(p.value / total) * 100} 1 0%`, ...p.style }}
              />
            ))}
          </div>
          <ul className="m-0 grid list-none grid-cols-1 gap-x-6 sm:grid-cols-2 gap-y-1 p-0 text-[12px] text-fg-muted">
            {parts.map((p) => (
              <li key={p.key} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-4 shrink-0 rounded-full"
                  style={p.style}
                />
                <span className="min-w-0 truncate">{p.label}</span>
                <span className="ml-auto font-mono text-[11.5px] text-fg-primary">
                  {formatEur(p.value)}/h
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Pane>
      <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] xl:grid-cols-2">
        {machines.map((m) => (
          <MachinePane key={m.id} machine={m} />
        ))}
      </div>
    </div>
  );
}
