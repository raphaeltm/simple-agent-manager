/** PROTOTYPE: a user-owned machine on the Nodes page. Mock data only. */
import { Button, Chip, type ChipTone, Pane } from '@simple-agent-manager/ui';
import { ChevronRight, Cloud, HardDrive } from 'lucide-react';

import type {
  MachineState,
  MockCloudNode,
  MockMachine,
  MockSession,
  PlacementMode,
} from './mock-data';

export const STATE_CHIP: Record<MachineState, { label: string; tone: ChipTone; dot?: boolean }> = {
  online: { label: 'Online', tone: 'success', dot: true },
  paused: { label: 'Paused', tone: 'muted' },
  offline: { label: 'Offline', tone: 'muted' },
  reconnect: { label: 'Reconnect needed', tone: 'warning' },
  updating: { label: 'Update pending', tone: 'info', dot: true },
  pending: { label: 'Waiting for install', tone: 'info', dot: true },
  'pending-expired': { label: 'Command expired', tone: 'muted' },
};

export const MODE_LABEL: Record<PlacementMode, string> = {
  automatic: 'Used first',
  manual: 'Only when I pick it',
  paused: 'Paused',
};

export function hardwareLine(machine: MockMachine): string {
  if (machine.vcpu == null) return 'Not connected yet';
  return [
    `${machine.vcpu} CPU`,
    `${machine.memoryGb} GB`,
    `${machine.diskFreeGb} GB free`,
    `${machine.os} ${machine.arch}`,
  ].join(' · ');
}

export function SessionLine({ session }: { session: MockSession }) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-2">
      <span
        aria-hidden="true"
        className={`mt-[7px] h-[7px] w-[7px] shrink-0 rounded-full ${
          session.state === 'working'
            ? 'bg-[var(--sam-status-success-fg)]'
            : 'bg-[var(--sam-hairline)]'
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="m-0 line-clamp-2 break-words text-[13px] text-fg-primary">{session.title}</p>
        <p className="m-0 font-mono text-[10.5px] text-fg-muted [overflow-wrap:anywhere]">
          {session.project} · {session.memoryGb} GB · {session.vcpu} CPU set aside
        </p>
      </div>
      <ChevronRight size={15} className="mt-1 shrink-0 text-fg-muted" aria-hidden="true" />
    </li>
  );
}

function StateNote({
  machine,
  onAction,
}: {
  machine: MockMachine;
  onAction: (action: 'command' | 'reconnect') => void;
}) {
  switch (machine.state) {
    case 'pending':
      return (
        <div className="sam-well flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] p-3">
          <p className="m-0 min-w-0 flex-1 basis-[180px] text-[13px] text-fg-muted">
            Waiting for you to run the command on this machine. Valid for 11 more minutes.
          </p>
          <Button size="sm" variant="raised" onClick={() => onAction('command')}>
            Show command
          </Button>
        </div>
      );
    case 'pending-expired':
      return (
        <div className="sam-well flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] p-3">
          <p className="m-0 min-w-0 flex-1 basis-[180px] text-[13px] text-fg-muted">
            The command expired before it was used. This entry is removed in an hour.
          </p>
          <Button size="sm" variant="raised" onClick={() => onAction('command')}>
            Get a new command
          </Button>
        </div>
      );
    case 'reconnect':
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-warning-tint p-3">
          <p className="m-0 min-w-0 flex-1 basis-[180px] text-[13px] text-warning-fg">
            Offline for {machine.lastSeen.replace(' ago', '')}, so its sign-in expired. One command
            brings it back with the same history.
          </p>
          <Button size="sm" variant="raised" onClick={() => onAction('reconnect')}>
            Get reconnect command
          </Button>
        </div>
      );
    case 'offline':
      return (
        <p className="m-0 text-[13px] text-fg-muted">
          Last seen {machine.lastSeen}. New work runs on your compute pool until it is back.
        </p>
      );
    case 'updating':
      return (
        <p className="m-0 text-[13px] text-fg-muted">
          A SAM update is waiting for {machine.sessions.length} session
          {machine.sessions.length === 1 ? '' : 's'} to sleep. No new work starts here until then.
        </p>
      );
    case 'paused':
      return (
        <p className="m-0 text-[13px] text-fg-muted">
          Paused. Nothing new starts here; anything already running keeps going.
        </p>
      );
    default:
      return null;
  }
}

export function MachineCard({
  machine,
  onOpen,
  onAction,
}: {
  machine: MockMachine;
  onOpen: (machine: MockMachine) => void;
  onAction: (action: 'command' | 'reconnect') => void;
}) {
  const chip = STATE_CHIP[machine.state];
  const connected = machine.state !== 'pending' && machine.state !== 'pending-expired';
  return (
    <Pane as="article" aria-label={machine.name} className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="sam-raised mt-0.5 hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--sam-radius-control)] md:grid">
          <HardDrive size={18} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1.5">
            <h2 className="m-0 line-clamp-2 min-w-0 flex-1 basis-[140px] break-words text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
              {machine.name}
            </h2>
            <span className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Chip tone={chip.tone} size="sm" dot={chip.dot}>
                {chip.label}
              </Chip>
              {connected && machine.state !== 'paused' && machine.mode === 'manual' && (
                <Chip tone="neutral" size="sm">
                  {MODE_LABEL.manual}
                </Chip>
              )}
            </span>
          </div>
          <p className="m-0 mt-0.5 text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
            Your machine · {hardwareLine(machine)}
            {connected ? ' · $0' : ''}
          </p>
        </div>
      </div>

      <StateNote machine={machine} onAction={onAction} />

      {machine.sessions.length > 0 && (
        <ul className="m-0 list-none divide-y divide-[var(--sam-hairline)] p-0">
          {machine.sessions.map((session) => (
            <SessionLine key={session.id} session={session} />
          ))}
        </ul>
      )}
      {connected && machine.sessions.length === 0 && machine.state === 'online' && (
        <p className="m-0 text-[13px] text-fg-muted">
          Nothing running. It stays connected; SAM never powers it off.
        </p>
      )}

      {connected && (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10.5px] text-fg-muted">
            {machine.limit
              ? `SAM may use up to ${machine.limit.vcpu} CPU · ${machine.limit.memoryGb} GB`
              : 'SAM may use the whole machine'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onOpen(machine)}>
            Manage
          </Button>
        </div>
      )}
    </Pane>
  );
}

/** A managed cloud node, drawn like today's Nodes page card so the two kinds sit side by side. */
export function CloudNodeCard({ node }: { node: MockCloudNode }) {
  return (
    <Pane as="article" aria-label={node.title} className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="sam-raised mt-0.5 hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--sam-radius-control)] md:grid">
          <Cloud size={18} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-fg-primary">
              {node.title}
            </h2>
            <Chip tone="success" size="sm" dot>
              {node.status}
            </Chip>
          </div>
          <p className="m-0 mt-0.5 text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
            {node.location} · {node.spec} · {node.price}
          </p>
        </div>
      </div>
      <p className="m-0 text-[13px] text-fg-muted">{node.note}</p>
    </Pane>
  );
}
