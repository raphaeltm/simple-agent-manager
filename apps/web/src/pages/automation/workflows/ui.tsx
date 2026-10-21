/**
 * Small pieces the Workflows pages share: step and run status marks, the one-segment-per-step
 * progress bar, and output chips. Colours come from the theme tokens so both themes work;
 * nothing relies on colour alone (every mark carries a text label for screen readers).
 */
import type {
  WorkflowRunStatus,
  WorkflowStepDetail,
  WorkflowStepStatus,
} from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';
import {
  AlarmClockOff,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Hourglass,
  Link2,
  LoaderCircle,
  Radio,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Link } from 'react-router';

import type { OutputLink } from './links';
import { RUN_STATUS_META, stepStatusMeta, type Tone } from './model';

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

export const TONE_COLOR: Record<Tone, string> = {
  muted: 'var(--sam-color-fg-muted)',
  info: 'var(--sam-color-info-fg)',
  success: 'var(--sam-color-success-fg)',
  warning: 'var(--sam-color-warning-fg)',
  danger: 'var(--sam-color-danger-fg)',
};

type StepMarkInput = Pick<WorkflowStepDetail, 'kind' | 'status'> & {
  wait?: WorkflowStepDetail['wait'];
};

function stepIcon(step: StepMarkInput): { Icon: IconType; spin: boolean } {
  if (step.kind === 'wait') {
    if (step.status === 'running') return { Icon: Radio, spin: false };
    if (step.status === 'failed' && step.wait?.timedOut)
      return { Icon: AlarmClockOff, spin: false };
    if (step.status === 'waiting') return { Icon: Hourglass, spin: false };
  }
  switch (step.status) {
    case 'waiting':
      return { Icon: CircleDashed, spin: false };
    case 'starting':
    case 'running':
      return { Icon: LoaderCircle, spin: true };
    case 'completed':
      return { Icon: CircleCheck, spin: false };
    case 'failed':
      return { Icon: CircleX, spin: false };
    case 'blocked':
      return { Icon: CircleSlash, spin: false };
  }
}

/** A step's state as an icon with its words for screen readers. */
export function StepMark({ step, size = 18 }: { step: StepMarkInput; size?: number }) {
  const meta = stepStatusMeta(step);
  const { Icon, spin } = stepIcon(step);
  return (
    <span className="inline-flex shrink-0" style={{ color: TONE_COLOR[meta.tone] }}>
      <Icon size={size} aria-hidden className={spin ? 'motion-safe:animate-spin' : undefined} />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

/** A step's state as a pill. Lists show it only for states worth noticing. */
export function StepBadge({ step }: { step: StepMarkInput }) {
  const meta = stepStatusMeta(step);
  return <StatusBadge status={meta.badge} label={meta.label} pulse={false} />;
}

export function RunBadge({ status }: { status: WorkflowRunStatus }) {
  const meta = RUN_STATUS_META[status];
  return <StatusBadge status={meta.badge} label={meta.label} pulse={status === 'active'} />;
}

const RUN_TILE: Record<WorkflowRunStatus, { Icon: IconType; tone: Tone }> = {
  active: { Icon: Workflow, tone: 'success' },
  needs_attention: { Icon: TriangleAlert, tone: 'warning' },
  completed: { Icon: CircleCheck, tone: 'muted' },
};

/** The leading tile of a run row. */
export function RunTile({ status }: { status: WorkflowRunStatus }) {
  const { Icon, tone } = RUN_TILE[status];
  const color = TONE_COLOR[tone];
  return (
    <span
      aria-hidden
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon size={18} />
    </span>
  );
}

const SEGMENT: Record<WorkflowStepStatus, string> = {
  waiting: 'var(--sam-color-border-default)',
  starting: 'color-mix(in srgb, var(--sam-color-info-fg) 70%, transparent)',
  running: 'var(--sam-color-success-fg)',
  completed: 'color-mix(in srgb, var(--sam-color-success-fg) 55%, transparent)',
  failed: 'var(--sam-color-danger-fg)',
  blocked: 'color-mix(in srgb, var(--sam-color-danger-fg) 25%, var(--sam-color-border-default))',
};

/**
 * One segment per step, in plan order. Decorative: the progress sentence beside it says the
 * same thing in words.
 */
export function StepProgressBar({
  steps,
  height = 6,
}: {
  steps: ReadonlyArray<{ key: string; status: WorkflowStepStatus }>;
  height?: number;
}) {
  return (
    <div aria-hidden className="flex w-full min-w-0 gap-[3px]" data-testid="workflow-progress">
      {steps.map((step) => (
        <span
          key={step.key}
          data-status={step.status}
          className={`min-w-[3px] flex-1 rounded-full ${step.status === 'running' ? 'motion-safe:animate-pulse' : ''}`}
          style={{ height, background: SEGMENT[step.status] }}
        />
      ))}
    </div>
  );
}

const OUTPUT_ICON: Record<OutputLink['kind'], IconType> = {
  library: FileText,
  'pull-request': GitPullRequest,
  url: Link2,
  branch: GitBranch,
  text: Link2,
};

/**
 * One output an agent reported: a Library file, a pull request, a link or a branch. Links open
 * only for shapes we can vouch for (see `links.ts`); the rest are shown as text.
 */
export function OutputChip({ link }: { link: OutputLink }) {
  const Icon = OUTPUT_ICON[link.kind];
  const body = (
    <>
      <Icon size={15} aria-hidden className="shrink-0 text-fg-muted" />
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-semibold text-fg-primary">{link.label}</span>
        <span className="break-all text-xs text-fg-muted">{link.detail}</span>
      </span>
      {link.external && (
        <ExternalLink size={13} aria-hidden className="ml-auto shrink-0 text-fg-muted" />
      )}
    </>
  );
  const box =
    'flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg border border-solid border-border-default px-3 py-1.5 no-underline';
  if (!link.href) return <span className={box}>{body}</span>;
  if (link.external)
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${box} hover:bg-surface-hover`}
      >
        {body}
      </a>
    );
  return (
    <Link to={link.href} className={`${box} hover:bg-surface-hover`}>
      {body}
    </Link>
  );
}
