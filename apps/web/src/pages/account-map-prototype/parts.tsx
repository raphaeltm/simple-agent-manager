/** PROTOTYPE building blocks shared by both account map directions. Never merge to main. */
import { Chip, type ChipTone, paneClassName } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  Bell,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Cloud,
  FolderKanban,
  GitPullRequest,
  Home,
  Loader2,
  Map as MapIcon,
  Menu,
  MessageCircleQuestion,
  MessageSquare,
  Moon,
  Server,
  Settings,
  Wrench,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { AttentionKind, MachineState, MockMachine, MockScene, MockWork, WorkState } from './mock-data';

export function lookup(scene: MockScene) {
  const project = (id: string | null | undefined) => scene.projects.find((p) => p.id === id);
  const workspace = (id: string | null | undefined) => scene.workspaces.find((w) => w.id === id);
  const machine = (id: string | null | undefined) => scene.machines.find((m) => m.id === id);
  const machineForWork = (w: MockWork) => machine(workspace(w.workspaceId)?.machineId);
  return { project, workspace, machine, machineForWork };
}

const WORK_STATE: Record<WorkState, { label: string; tone: ChipTone }> = {
  working: { label: 'Working', tone: 'success' },
  'needs-you': { label: 'Needs you', tone: 'warning' },
  idle: { label: 'Idle', tone: 'muted' },
  sleeping: { label: 'Asleep', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  done: { label: 'Done', tone: 'neutral' },
};

export function WorkStateIcon({ state, size = 15 }: { state: WorkState; size?: number }) {
  if (state === 'working') {
    return <Loader2 size={size} className="shrink-0 animate-spin text-[var(--sam-status-success-fg)]" aria-label="Working" />;
  }
  if (state === 'needs-you') {
    return <MessageCircleQuestion size={size} className="shrink-0 text-[var(--sam-status-warning-fg)]" aria-label="Needs you" />;
  }
  if (state === 'failed') {
    return <CircleAlert size={size} className="shrink-0 text-[var(--sam-status-danger-fg)]" aria-label="Failed" />;
  }
  if (state === 'done') {
    return <CircleCheck size={size} className="shrink-0 text-fg-muted" aria-label="Done" />;
  }
  if (state === 'sleeping') {
    return <Moon size={size} className="shrink-0 text-fg-muted" aria-label="Asleep" />;
  }
  return <CircleDot size={size} className="shrink-0 text-fg-muted" aria-label="Idle" />;
}

export function WorkStateChip({ state }: { state: WorkState }) {
  const s = WORK_STATE[state];
  return (
    <Chip tone={s.tone} size="sm" dot={state === 'working' || state === 'needs-you'}>
      {s.label}
    </Chip>
  );
}

const MACHINE_STATE: Record<MachineState, { label: string; tone: ChipTone }> = {
  running: { label: 'Running', tone: 'success' },
  warm: { label: 'Warm, unused', tone: 'muted' },
  starting: { label: 'Starting', tone: 'info' },
  unhealthy: { label: 'Not responding', tone: 'danger' },
};

export function MachineStateChip({ machine }: { machine: MockMachine }) {
  if (machine.instant) return <Chip tone="info" size="sm">On demand</Chip>;
  const s = MACHINE_STATE[machine.state];
  return (
    <Chip tone={s.tone} size="sm" dot={machine.state === 'running'}>
      {s.label}
    </Chip>
  );
}

export function MachineIcon({ machine, size = 16 }: { machine: MockMachine; size?: number }) {
  return machine.instant ? (
    <Zap size={size} className="shrink-0 text-[var(--sam-status-info-fg)]" aria-hidden="true" />
  ) : (
    <Server size={size} className="shrink-0 text-fg-muted" aria-hidden="true" />
  );
}

export function AttentionIcon({ kind, size = 18 }: { kind: AttentionKind; size?: number }) {
  if (kind === 'question') {
    return <MessageCircleQuestion size={size} className="shrink-0 text-[var(--sam-status-warning-fg)]" aria-hidden="true" />;
  }
  if (kind === 'review') {
    return <GitPullRequest size={size} className="shrink-0 text-[var(--sam-status-warning-fg)]" aria-hidden="true" />;
  }
  if (kind === 'cost') {
    return <Cloud size={size} className="shrink-0 text-[var(--sam-status-warning-fg)]" aria-hidden="true" />;
  }
  if (kind === 'machine') {
    return <AlertTriangle size={size} className="shrink-0 text-[var(--sam-status-danger-fg)]" aria-hidden="true" />;
  }
  return <CircleAlert size={size} className="shrink-0 text-[var(--sam-status-danger-fg)]" aria-hidden="true" />;
}

/** One usage bar. Amber past 80% (SAM stops placing new work there), red past 92%. */
export function Meter({ label, value }: { label: string; value: number }) {
  const color =
    value >= 92 ? 'var(--sam-status-danger-fg)' : value >= 80 ? 'var(--sam-status-warning-fg)' : 'var(--sam-status-success-fg)';
  return (
    <div className="min-w-0 flex-1" aria-label={`${label} ${value}%`}>
      <div className="flex items-baseline justify-between gap-1 text-[11px] text-fg-muted">
        <span>{label}</span>
        <span className="font-mono" style={{ color: value >= 80 ? color : undefined }}>
          {value}%
        </span>
      </div>
      <div className="sam-well mt-1 h-1.5 overflow-hidden rounded-full">
        <div className="h-full rounded-full" style={{ width: `${Math.max(value, 2)}%`, background: color }} />
      </div>
    </div>
  );
}

/** A solid project initial, like the sidebar's recent-projects list. */
export function ProjectMark({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="sam-raised grid shrink-0 place-items-center rounded-[7px] font-semibold text-fg-primary"
      style={{ width: size, height: size, fontSize: size * 0.48 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function PrChip({ pr }: { pr: NonNullable<MockWork['pr']> }) {
  const tone: ChipTone =
    pr.state === 'checks failing' ? 'danger' : pr.state === 'ready to merge' ? 'success' : pr.state === 'merged' ? 'muted' : 'info';
  return (
    <Chip tone={tone} size="sm" icon={<GitPullRequest size={11} aria-hidden="true" />}>
      #{pr.number}
    </Chip>
  );
}

export function formatCost(perHour: number) {
  return perHour === 0 ? 'Usage based' : `$${perHour.toFixed(perHour < 0.1 ? 3 : 2)}/h`;
}

const NAV = [
  { icon: Home, label: 'Home' },
  { icon: Bot, label: 'SAM' },
  { icon: MessageSquare, label: 'Chats' },
  { icon: FolderKanban, label: 'Projects' },
  { icon: MapIcon, label: 'Map', current: true },
  { icon: Wrench, label: 'Tools' },
  { icon: Server, label: 'Infrastructure' },
  { icon: Settings, label: 'Settings' },
];

/** A static copy of the desktop sidebar so screenshots read like the real app. */
function MockSidebar() {
  return (
    <aside className={`${paneClassName('pane')} flex min-h-0 flex-col gap-1 p-3`}>
      <div className="mb-3 flex h-10 items-center gap-2 px-2">
        <span className="h-7 w-7 rounded-full bg-[var(--sam-status-success-fg)]" aria-hidden="true" />
        <span className="flex-1" />
        <MessageSquare size={18} className="text-fg-muted" aria-hidden="true" />
        <Bell size={18} className="text-fg-muted" aria-hidden="true" />
      </div>
      {NAV.map(({ icon: Icon, label, current }) => (
        <div
          key={label}
          className={`flex h-10 items-center gap-3 rounded-[var(--sam-radius-control)] px-3 text-[14px] ${
            current ? 'sam-raised text-fg-primary' : 'text-fg-muted'
          }`}
        >
          <Icon size={18} strokeWidth={1.75} className={current ? 'text-[var(--sam-status-success-fg)]' : ''} aria-hidden="true" />
          {label}
        </div>
      ))}
    </aside>
  );
}

/** The app shell around a prototype: void, sidebar and one content pane on desktop; app bar on phones. */
export function PrototypeFrame({ isMobile, children }: { isMobile: boolean; children: ReactNode }) {
  if (isMobile) {
    return (
      <div className="sam-void flex h-dvh flex-col gap-2.5 p-2.5">
        <div className={`${paneClassName('slab')} flex h-14 shrink-0 items-center gap-3 px-3`}>
          <Menu size={20} className="text-fg-muted" aria-hidden="true" />
          <span className="flex-1 text-[17px] font-semibold text-fg-primary">Map</span>
          <span className="sam-well flex items-center gap-3 rounded-[var(--sam-radius-control)] px-2.5 py-2">
            <MessageSquare size={18} className="text-fg-muted" aria-hidden="true" />
            <Bell size={18} className="text-fg-muted" aria-hidden="true" />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    );
  }
  return (
    <div
      className="sam-void grid h-screen gap-[var(--sam-space-gutter)] p-4"
      style={{ gridTemplateColumns: '220px minmax(0, 1fr)', ['--sam-void-x' as string]: '58%' }}
    >
      <MockSidebar />
      <div className="min-h-0 min-w-0">{children}</div>
    </div>
  );
}
