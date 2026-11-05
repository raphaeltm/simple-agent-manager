/** Small pieces shared by the Account Map's desktop columns and phone list. */
import { PROVIDER_LABELS } from '@simple-agent-manager/shared';
import { Chip, type ChipTone } from '@simple-agent-manager/ui';
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  GitPullRequest,
  Lightbulb,
  Loader2,
  MessageCircleQuestion,
  Moon,
  Server,
  Zap,
} from 'lucide-react';

import type { ConnectionsModel, MapMachine, MapWork, WorkState } from './connections-model';

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  working: 'Working',
  idle: 'Idle',
  asleep: 'Asleep',
  done: 'Done',
};

const WORK_STATE_TONE: Record<WorkState, ChipTone> = {
  'needs-you': 'warning',
  failed: 'danger',
  working: 'success',
  idle: 'muted',
  asleep: 'muted',
  done: 'neutral',
};

export function WorkStateIcon({ state, size = 14 }: { state: WorkState; size?: number }) {
  const label = WORK_STATE_LABEL[state];
  if (state === 'working') {
    return (
      <Loader2
        size={size}
        role="img"
        aria-label={label}
        className="mt-0.5 shrink-0 animate-spin text-[var(--sam-status-success-fg)] motion-reduce:animate-none"
      />
    );
  }
  const Icon =
    state === 'needs-you'
      ? MessageCircleQuestion
      : state === 'failed'
        ? CircleAlert
        : state === 'done'
          ? CircleCheck
          : state === 'asleep'
            ? Moon
            : CircleDot;
  const color =
    state === 'needs-you'
      ? 'text-[var(--sam-status-warning-fg)]'
      : state === 'failed'
        ? 'text-[var(--sam-status-danger-fg)]'
        : 'text-fg-muted';
  return <Icon size={size} role="img" aria-label={label} className={`mt-0.5 shrink-0 ${color}`} />;
}

export function WorkStateChip({ state }: { state: WorkState }) {
  return (
    <Chip
      tone={WORK_STATE_TONE[state]}
      size="sm"
      dot={state === 'working' || state === 'needs-you'}
    >
      {WORK_STATE_LABEL[state]}
    </Chip>
  );
}

/** What a machine is doing, in the words on its chip. Health wins over a "running" status. */
export function machineState(machine: MapMachine): { label: string; tone: ChipTone } {
  if (machine.placeholder) return { label: 'Instant', tone: 'info' };
  if (machine.status === 'error' || machine.health === 'unhealthy')
    return { label: 'Not responding', tone: 'danger' };
  if (machine.health === 'stale') return { label: 'No recent heartbeat', tone: 'muted' };
  if (machine.status === 'running' || machine.status === 'recovery')
    return { label: 'Running', tone: 'success' };
  if (machine.status === 'pending' || machine.status === 'creating')
    return { label: 'Starting', tone: 'info' };
  if (machine.status === 'sleeping') return { label: 'Asleep', tone: 'muted' };
  if (machine.status === 'stopping') return { label: 'Stopping', tone: 'muted' };
  return { label: 'Stopped', tone: 'muted' };
}

export function MachineStateChip({ machine }: { machine: MapMachine }) {
  const { label, tone } = machineState(machine);
  return (
    <Chip tone={tone} size="sm" dot={tone === 'success'}>
      {label}
    </Chip>
  );
}

export function MachineIcon({ machine }: { machine: MapMachine }) {
  return machine.placeholder ? (
    <Zap size={16} aria-hidden="true" className="shrink-0 text-[var(--sam-status-info-fg)]" />
  ) : (
    <Server size={16} aria-hidden="true" className="shrink-0 text-fg-muted" />
  );
}

/** "Hetzner · cx43 · fsn1", skipping what the node does not report. */
export function machineDetail(machine: MapMachine): string {
  if (machine.placeholder) return 'Instant workspaces, or not placed yet';
  const provider = machine.provider
    ? (PROVIDER_LABELS[machine.provider as keyof typeof PROVIDER_LABELS] ?? machine.provider)
    : null;
  return [provider, machine.size, machine.location].filter(Boolean).join(' · ') || 'Machine';
}

/** A solid project initial, like the sidebar's recent-projects list. */
export function ProjectMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="sam-raised grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px] text-[11px] font-semibold text-fg-primary"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** "#123" for a GitHub pull request URL, "PR" for anything else. */
export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : 'PR';
}

export function ideaTitles(model: ConnectionsModel, work: MapWork): string[] {
  return work.ideaIds
    .map((id) => model.ideas.get(id)?.title)
    .filter((t): t is string => Boolean(t));
}

/**
 * How a row looks when something else is picked: no fill, a hairline border and muted text.
 * Not `opacity`, which would take text below 4.5:1 on the glass.
 */
export const STEPPED_BACK = 'border-[var(--sam-hairline)] bg-transparent';

/** One chat or task. A button: picking it lights its chain. */
export function WorkRow({
  model,
  work,
  dim,
  selected,
  onSelect,
}: {
  model: ConnectionsModel;
  work: MapWork;
  dim: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const ideas = ideaTitles(model, work);
  return (
    <button
      type="button"
      data-node={work.id}
      aria-pressed={selected}
      onClick={() => onSelect(work.id)}
      data-dimmed={dim || undefined}
      className={`flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-[var(--sam-radius-control)] border border-solid px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
        selected
          ? 'sam-raised border-[var(--sam-success-edge)]'
          : dim
            ? STEPPED_BACK
            : work.state === 'needs-you'
              ? 'border-[var(--sam-warning-edge)] bg-[var(--sam-chip-bg)]'
              : 'border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)]'
      }`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <WorkStateIcon state={work.state} />
        <span
          className={`line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium [overflow-wrap:anywhere] ${dim ? 'text-fg-muted' : 'text-fg-primary'}`}
        >
          {work.title}
        </span>
        {work.prUrl && (
          <Chip tone="info" size="sm" icon={<GitPullRequest size={11} aria-hidden="true" />}>
            {prLabel(work.prUrl)}
          </Chip>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 pl-[22px] text-[11.5px] text-fg-muted">
        <span className="shrink-0">{work.kind === 'task' ? 'Task' : 'Chat'}</span>
        <span className="shrink-0">{WORK_STATE_LABEL[work.state]}</span>
        {ideas.length > 0 && (
          <span className="flex min-w-0 items-center gap-1">
            <Lightbulb size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{ideas.join(', ')}</span>
          </span>
        )}
      </span>
    </button>
  );
}
