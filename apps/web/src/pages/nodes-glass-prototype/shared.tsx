// PROTOTYPE ONLY — pieces shared by the four /prototype/nodes-glass concepts.
import { Chip, PersonAvatar } from '@simple-agent-manager/ui';
import { CircleAlert, Loader2, Moon, Server } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ProtoMachine, ProtoSession, SessionState } from './mock-data';
import {
  formatAge,
  machineSpec,
  machineSpecShort,
  machineTitle,
  SESSION_STATE_LABEL,
} from './model';

export function SessionStateIcon({ state, size = 16 }: { state: SessionState; size?: number }) {
  const label = SESSION_STATE_LABEL[state];
  if (state === 'working') {
    return (
      <Loader2
        size={size}
        strokeWidth={2}
        aria-label={label}
        className="shrink-0 animate-spin text-[var(--sam-status-success-fg)] motion-reduce:animate-none"
      />
    );
  }
  if (state === 'needs-you') {
    return (
      <CircleAlert
        size={size}
        strokeWidth={2}
        aria-label={label}
        className="shrink-0 text-[var(--sam-color-warning)]"
      />
    );
  }
  return (
    <Moon size={size} strokeWidth={1.75} aria-label={label} className="shrink-0 text-fg-muted" />
  );
}

export function MachineStateChip({ machine }: { machine: ProtoMachine }) {
  switch (machine.state) {
    case 'running':
      return (
        <Chip tone="success" size="sm" dot>
          Running
        </Chip>
      );
    case 'warm':
      return (
        <Chip tone="muted" size="sm">
          Warm
        </Chip>
      );
    case 'starting':
      return (
        <Chip tone="info" size="sm" dot>
          Starting
        </Chip>
      );
    default:
      return (
        <Chip tone="danger" size="sm">
          Error
        </Chip>
      );
  }
}

/** A machine is named for what it is, never for the first task that started it. */
export function MachineHeading({
  machine,
  trailing,
}: {
  machine: ProtoMachine;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="sam-raised mt-0.5 hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--sam-radius-control)] md:grid">
        <Server size={18} strokeWidth={1.75} className="text-fg-muted" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="m-0 min-w-0 truncate text-[15px] font-semibold text-fg-primary">
            {machineTitle(machine)}
          </h3>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {trailing}
            <MachineStateChip machine={machine} />
          </span>
        </div>
        <p className="m-0 mt-0.5 truncate text-[12.5px] text-fg-muted">
          {machine.location} · <span className="md:hidden">{machineSpecShort(machine)}</span>
          <span className="hidden md:inline">{machineSpec(machine)}</span>
        </p>
      </div>
    </div>
  );
}

/** "You", a teammate's first name, or "Automation", so the meta line stays one line. */
export function ownerLabel(session: ProtoSession): string {
  if (session.owner.slot === 'you') return 'You';
  if (session.owner.slot === 'auto') return 'Automation';
  return session.owner.name.split(' ')[0] ?? session.owner.name;
}

/** Owner avatar, name, project and age, as on the chat list's meta line. */
export function SessionMeta({
  session,
  showProject = true,
}: {
  session: ProtoSession;
  showProject?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
      <PersonAvatar name={session.owner.name} person={session.owner.slot} size={14} decorative />
      <span className="shrink-0">{ownerLabel(session)}</span>
      {showProject && (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{session.project}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span className="shrink-0 font-mono text-[11px]">{formatAge(session.startedMinutesAgo)}</span>
    </div>
  );
}

/** Session titles wrap to two lines on a phone rather than cutting off after a few words. */
export function SessionTitle({ session }: { session: ProtoSession }) {
  return (
    <span className="line-clamp-2 break-words text-[13.5px] font-medium text-fg-primary md:line-clamp-1">
      {session.title}
    </span>
  );
}

export function EmptyMachineNote({ machine }: { machine: ProtoMachine }) {
  if (machine.state === 'starting') {
    return (
      <p className="m-0 text-[13px] text-fg-muted">
        Starting up. Your next session will run here in about a minute.
      </p>
    );
  }
  if (machine.state === 'warm') {
    return (
      <p className="m-0 text-[13px] text-fg-muted">
        Nothing running. SAM keeps it warm so the next session starts fast, and removes it in{' '}
        <span className="text-fg-primary">{machine.warmMinutesLeft} minutes</span> if nothing does.
      </p>
    );
  }
  return <p className="m-0 text-[13px] text-fg-muted">Nothing running.</p>;
}

/** A small "Advanced" link for the workspace, the debugging view most people never need. */
export function WorkspaceLink({ session }: { session: ProtoSession }) {
  return (
    <a
      href={`#workspace-${session.workspaceId}`}
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-[11px] text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg-primary"
      title="Open the workspace (advanced: terminal, files, logs)"
    >
      ws {session.workspaceId.slice(-6).toLowerCase()}
    </a>
  );
}

/** The workspace and node IDs, folded away: they are for debugging, not for everyday use. */
export function AdvancedLinks({
  machine,
  sessions,
}: {
  machine: ProtoMachine;
  sessions: ProtoSession[];
}) {
  return (
    <details className="text-[11.5px] text-fg-muted">
      <summary className="cursor-pointer select-none">Advanced</summary>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {sessions.map((s) => (
          <WorkspaceLink key={s.id} session={s} />
        ))}
        <span className="font-mono text-[11px]">node {machine.id.slice(-6).toLowerCase()}</span>
      </div>
    </details>
  );
}
