/**
 * PROTOTYPE ONLY — status vocabulary and small shared pieces for the Workflows
 * exploration. Colors come from the real design tokens; amber is reserved for
 * "waiting for you" so an approval is the one thing that pops.
 */
import {
  AlertTriangle,
  BadgeCheck,
  Bookmark,
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  CircleStop,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Hand,
  Hourglass,
  Loader2,
  type LucideIcon,
  PauseCircle,
  PenLine,
  Play,
  Rocket,
  Server,
  ShieldCheck,
  SkipForward,
  Sparkles,
  StickyNote,
  TestTube2,
  ThumbsDown,
  User2,
  XCircle,
  Zap,
} from 'lucide-react';

import { PROFILES } from './mock-world';
import type { Evidence, RunDef, RunFrame, RunStatus, StepDef, StepStatus } from './model';

interface Meta {
  label: string;
  icon: LucideIcon;
  color: string;
  spin?: boolean;
  /** --sam-status-* pair used for pills */
  tone: 'muted' | 'info' | 'success' | 'warning' | 'danger';
}

const C = {
  success: 'var(--sam-color-success)',
  danger: 'var(--sam-color-danger)',
  warning: 'var(--sam-color-warning)',
  info: 'var(--sam-color-info)',
  muted: 'var(--sam-color-fg-muted)',
};

export const STEP_META: Record<StepStatus, Meta> = {
  waiting: { label: 'Waiting', icon: CircleDashed, color: C.muted, tone: 'muted' },
  up_next: { label: 'Up next', icon: Hourglass, color: C.info, tone: 'info' },
  starting: { label: 'Starting', icon: Loader2, color: C.info, spin: true, tone: 'info' },
  running: { label: 'Running', icon: Loader2, color: C.success, spin: true, tone: 'success' },
  done: { label: 'Done', icon: CheckCircle2, color: C.success, tone: 'success' },
  failed: { label: 'Failed', icon: XCircle, color: C.danger, tone: 'danger' },
  blocked: { label: 'Blocked', icon: CircleSlash, color: C.muted, tone: 'muted' },
  needs_you: { label: 'Waiting for you', icon: Hand, color: C.warning, tone: 'warning' },
  approved: { label: 'Approved', icon: BadgeCheck, color: C.success, tone: 'success' },
  rejected: { label: 'Rejected', icon: ThumbsDown, color: C.danger, tone: 'danger' },
  skipped: { label: 'Skipped', icon: SkipForward, color: C.muted, tone: 'muted' },
  cancelled: { label: 'Cancelled', icon: CircleStop, color: C.muted, tone: 'muted' },
};

export const RUN_META: Record<RunStatus, Meta> = {
  draft: { label: 'Draft', icon: PenLine, color: C.muted, tone: 'muted' },
  running: { label: 'Running', icon: Loader2, color: C.success, spin: true, tone: 'success' },
  needs_you: { label: 'Waiting for you', icon: Hand, color: C.warning, tone: 'warning' },
  needs_attention: {
    label: 'Needs attention',
    icon: AlertTriangle,
    color: C.danger,
    tone: 'danger',
  },
  paused: { label: 'Paused', icon: PauseCircle, color: C.info, tone: 'info' },
  done: { label: 'Done', icon: CheckCircle2, color: C.success, tone: 'success' },
  cancelled: { label: 'Cancelled', icon: CircleStop, color: C.muted, tone: 'muted' },
};

export function StepIcon({ status, size = 16 }: { status: StepStatus; size?: number }) {
  const m = STEP_META[status];
  const Icon = m.icon;
  return (
    <span className="shrink-0 inline-flex" style={{ color: m.color }} title={m.label}>
      <Icon size={size} className={m.spin ? 'motion-safe:animate-spin' : ''} aria-hidden />
      <span className="sr-only">{m.label}</span>
    </span>
  );
}

/** Pill in the same geometry as the real StatusBadge (rounded-full, xs, semibold). */
export function Pill({
  tone,
  children,
  icon: Icon,
  spin,
}: {
  tone: Meta['tone'];
  children: React.ReactNode;
  icon?: LucideIcon;
  spin?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: `var(--sam-status-${tone}-bg)`, color: `var(--sam-status-${tone}-fg)` }}
    >
      {Icon && <Icon size={11} className={spin ? 'motion-safe:animate-spin' : ''} aria-hidden />}
      {children}
    </span>
  );
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const m = RUN_META[status];
  return (
    <Pill tone={m.tone} icon={m.icon} spin={m.spin}>
      {m.label}
    </Pill>
  );
}

const SEGMENT_COLOR: Record<StepStatus, string> = {
  waiting: 'var(--sam-color-border-default)',
  up_next: 'color-mix(in srgb, var(--sam-color-info) 55%, transparent)',
  starting: 'color-mix(in srgb, var(--sam-color-info) 75%, transparent)',
  running: 'var(--sam-color-success)',
  done: 'color-mix(in srgb, var(--sam-color-success) 70%, transparent)',
  failed: 'var(--sam-color-danger)',
  blocked: 'color-mix(in srgb, var(--sam-color-danger) 30%, var(--sam-color-border-default))',
  needs_you: 'var(--sam-color-warning)',
  approved: 'color-mix(in srgb, var(--sam-color-success) 70%, transparent)',
  rejected: 'var(--sam-color-danger)',
  skipped: 'color-mix(in srgb, var(--sam-color-fg-muted) 45%, transparent)',
  cancelled: 'color-mix(in srgb, var(--sam-color-fg-muted) 35%, transparent)',
};

/** One segment per step, in checklist order. Running segments shimmer. */
export function StepProgressBar({
  steps,
  frame,
  height = 6,
  className = '',
}: {
  steps: StepDef[];
  frame: RunFrame;
  height?: number;
  className?: string;
}) {
  return (
    <div className={`flex w-full gap-[3px] ${className}`} aria-hidden>
      {steps.map((s) => {
        const st = frame.steps[s.key]?.status ?? 'waiting';
        return (
          <span
            key={s.key}
            className={`flex-1 rounded-full ${st === 'running' || st === 'needs_you' ? 'motion-safe:animate-pulse' : ''}`}
            style={{ height, background: SEGMENT_COLOR[st], minWidth: 3 }}
            title={`${s.title}: ${STEP_META[st].label}`}
          />
        );
      })}
    </div>
  );
}

export function ProfileChip({ profileId, compact }: { profileId?: string; compact?: boolean }) {
  if (!profileId) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted">
        <User2 size={11} aria-hidden /> You
      </span>
    );
  }
  const p = PROFILES[profileId];
  if (!p) return null;
  const Runtime = p.runtime === 'instant' ? Zap : Server;
  return (
    <span
      className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-full border border-border-default px-2 py-0.5 text-[11px] font-medium text-fg-muted"
      title={`${p.name} · ${p.runtime === 'instant' ? 'Instant' : 'VM'}`}
    >
      <Bot size={11} className="shrink-0" aria-hidden />
      <span className="truncate">{p.name}</span>
      {!compact && <Runtime size={10} className="shrink-0 opacity-70" aria-hidden />}
    </span>
  );
}

const EVIDENCE_ICON: Record<Evidence['kind'], LucideIcon> = {
  pr: GitPullRequest,
  branch: GitBranch,
  tests: TestTube2,
  file: FileText,
  commit: GitCommitHorizontal,
  deploy: Rocket,
  note: StickyNote,
};

export function EvidenceChip({ e }: { e: Evidence }) {
  const Icon = EVIDENCE_ICON[e.kind];
  return (
    <span
      className="inline-flex items-center gap-1 max-w-full rounded-md border px-1.5 py-0.5 text-[11px]"
      style={{
        borderColor: e.ok
          ? 'color-mix(in srgb, var(--sam-color-success) 35%, transparent)'
          : 'var(--sam-color-border-default)',
        color: e.ok ? 'var(--sam-color-success-fg, #4ade80)' : 'var(--sam-color-fg-muted)',
      }}
      title={e.source === 'sam' ? 'Checked by SAM' : 'Reported by the agent'}
    >
      <Icon size={11} className="shrink-0" aria-hidden />
      <span className="truncate">{e.label}</span>
      {e.detail && <span className="hidden sm:inline truncate opacity-80">· {e.detail}</span>}
      {e.source === 'sam' && (
        <ShieldCheck size={11} className="shrink-0 opacity-90" aria-label="Checked by SAM" />
      )}
    </span>
  );
}

/** Where a run came from, in words people use: saved workflow vs one-off. */
export function OriginChip({ run }: { run: RunDef }) {
  if (run.origin.kind === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-fg-muted">
        <Play size={11} aria-hidden />
        Run #{run.origin.runNumber}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium"
      style={{ color: 'var(--sam-color-info)' }}
    >
      <Sparkles size={11} aria-hidden />
      One-off run
    </span>
  );
}

export function SavedChip({ version }: { version: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-default px-2 py-0.5 text-[11px] font-medium text-fg-muted">
      <Bookmark size={11} aria-hidden />
      Saved workflow · v{version}
    </span>
  );
}

export function StarterLabel({ run }: { run: RunDef }) {
  const text =
    run.startedBy === 'schedule'
      ? 'Started by schedule'
      : run.startedBy === 'your-agent'
        ? 'Started by your agent'
        : 'Started by you';
  const Icon =
    run.startedBy === 'schedule' ? CalendarClock : run.startedBy === 'your-agent' ? Bot : User2;
  return (
    <span className="inline-flex items-center gap-1 text-fg-muted">
      <Icon size={12} aria-hidden />
      {text} · {run.startedAgo}
    </span>
  );
}
