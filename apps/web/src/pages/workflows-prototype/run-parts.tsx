/**
 * PROTOTYPE ONLY — pieces of the run page: the one-line "what needs you"
 * callout, the plain-language activity log (every decision SAM made and why),
 * and the cancel / save-as-workflow dialogs.
 */
import { Button, Dialog, Timeline, TimelineItem } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  CircleStop,
  Hand,
  PauseCircle,
  Play,
  RotateCcw,
  SkipForward,
} from 'lucide-react';
import { useState } from 'react';

import type { ActivityEntry, RunDef, RunFrame } from './model';
import { countSteps } from './model';
import { STEP_META } from './status-ui';

const TONE_COLOR: Record<NonNullable<ActivityEntry['tone']>, string> = {
  default: 'var(--sam-color-fg-muted)',
  success: 'var(--sam-color-success)',
  warning: 'var(--sam-color-warning)',
  danger: 'var(--sam-color-danger)',
  muted: 'var(--sam-color-fg-muted)',
};

export function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="rounded-lg border border-border-default p-3 bg-[color-mix(in_srgb,var(--sam-color-bg-surface)_60%,transparent)]">
      <p className="m-0 mb-3 text-xs text-fg-muted">
        Every decision SAM made for this run, newest last. Nothing here needed a coordinator agent.
      </p>
      <Timeline>
        {entries.map((e, i) => (
          <TimelineItem key={`${e.at}-${i}`} dot={{ color: TONE_COLOR[e.tone ?? 'default'] }}>
            <div className="flex gap-2 text-xs leading-relaxed pb-3">
              <span className="tabular-nums text-fg-muted shrink-0 w-10">{e.at}</span>
              <span className="text-fg-primary break-words">{e.text}</span>
            </div>
          </TimelineItem>
        ))}
      </Timeline>
    </div>
  );
}

function Callout({
  tone,
  icon: Icon,
  title,
  body,
  children,
}: {
  tone: 'warning' | 'danger' | 'info' | 'success' | 'muted';
  icon: typeof Hand;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  const color = tone === 'muted' ? 'var(--sam-color-fg-muted)' : `var(--sam-color-${tone})`;
  return (
    <div
      className="rounded-lg px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2.5"
      style={{
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      }}
      role="status"
      data-testid="run-callout"
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <Icon size={17} className="shrink-0 mt-0.5" style={{ color }} aria-hidden />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg-primary break-words">{title}</div>
          {body && <div className="text-xs text-fg-muted leading-relaxed break-words">{body}</div>}
        </div>
      </div>
      {children && <div className="flex flex-wrap gap-2 shrink-0">{children}</div>}
    </div>
  );
}

export function RunCallout({
  run,
  frame,
  onDecide,
  onRetry,
  onSkip,
  onResume,
  onSave,
}: {
  run: RunDef;
  frame: RunFrame;
  onDecide: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onResume: () => void;
  onSave: () => void;
}) {
  const waiting = run.steps.find((s) => frame.steps[s.key]?.status === 'needs_you');
  const failed = run.steps.find((s) =>
    ['failed', 'rejected'].includes(frame.steps[s.key]?.status ?? '')
  );
  const blocked = run.steps.filter((s) => frame.steps[s.key]?.status === 'blocked');
  const counts = countSteps(frame, run.steps);

  if (waiting) {
    return (
      <Callout tone="warning" icon={Hand} title="Your approval is needed" body={waiting.question}>
        <Button
          size="sm"
          onClick={onDecide}
          style={{ background: 'var(--sam-color-warning)', color: '#1a1205' }}
        >
          <Hand size={14} /> Review and decide
        </Button>
      </Callout>
    );
  }
  if (failed && frame.status === 'needs_attention') {
    const failedState = frame.steps[failed.key]?.status;
    const blockedNames = blocked.map((s) => `“${s.title}”`).join(', ');
    return (
      <Callout
        tone="danger"
        icon={AlertTriangle}
        title={`“${failed.title}” ${failedState === 'rejected' ? 'was rejected' : 'failed'}`}
        body={`${blockedNames ? `${blockedNames} can’t start until you act. ` : ''}${counts.running ? 'Steps that don’t depend on it keep going.' : 'Nothing else is running.'}`}
      >
        {failedState === 'failed' ? (
          <>
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RotateCcw size={14} /> Retry with changes
            </Button>
            <Button size="sm" variant="ghost" onClick={onSkip}>
              <SkipForward size={14} /> Skip it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={onDecide}>
            Change your decision
          </Button>
        )}
      </Callout>
    );
  }
  if (frame.status === 'paused') {
    return (
      <Callout
        tone="info"
        icon={PauseCircle}
        title="Paused by you"
        body="No new steps start. Steps already running finish their work."
      >
        <Button size="sm" variant="secondary" onClick={onResume}>
          <Play size={14} /> Resume
        </Button>
      </Callout>
    );
  }
  if (frame.status === 'draft') {
    return (
      <Callout
        tone="muted"
        icon={Bookmark}
        title="Draft — nothing has started"
        body="Your agent drafted this plan because you asked to see it first. Starting it works like dispatching tasks."
      >
        <Button size="sm">
          <Play size={14} /> Start run
        </Button>
      </Callout>
    );
  }
  if (frame.status === 'done') {
    const retries = run.steps.reduce(
      (n, s) =>
        n + (frame.steps[s.key]?.attempts?.filter((a) => a.status === 'failed').length ?? 0),
      0
    );
    return (
      <Callout
        tone="success"
        icon={CheckCircle2}
        title={`Done in ${frame.elapsed}`}
        body={`${counts.done} of ${counts.total} steps${retries ? ` · ${retries} retr${retries === 1 ? 'y' : 'ies'}` : ''}${run.origin.kind === 'one_off' ? ' · Worth repeating? Save it as a workflow.' : ''}`}
      >
        {run.origin.kind === 'one_off' && (
          <Button size="sm" onClick={onSave}>
            <Bookmark size={14} /> Save as workflow
          </Button>
        )}
      </Callout>
    );
  }
  if (frame.status === 'cancelled') {
    return (
      <Callout
        tone="muted"
        icon={CircleStop}
        title="You cancelled this run"
        body="Running steps pushed their work before stopping. Cancelled is not a failure."
      />
    );
  }
  return null;
}

export function CancelDialog({
  isOpen,
  onClose,
  onConfirm,
  runningCount,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  runningCount: number;
}) {
  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="sm" aria-labelledby="cancel-run-title">
      <div className="p-5 flex flex-col gap-3">
        <h2 id="cancel-run-title" className="m-0 text-base font-semibold text-fg-primary">
          Cancel this run?
        </h2>
        <ul className="m-0 pl-4 text-sm text-fg-muted leading-relaxed">
          <li>
            {runningCount} running step{runningCount === 1 ? '' : 's'} will push{' '}
            {runningCount === 1 ? 'its' : 'their'} work, then stop.
          </li>
          <li>Steps that haven’t started won’t start.</li>
          <li>It shows as “Cancelled”, not failed. You can start it again later.</li>
        </ul>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Keep running
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Cancel run
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function SaveAsDialog({
  isOpen,
  onClose,
  onSave,
  run,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  run: RunDef;
}) {
  const [name, setName] = useState('Technology comparison');
  const [blanks, setBlanks] = useState({ topic: true, options: true, criteria: false });
  const toggle = (k: keyof typeof blanks) => setBlanks((b) => ({ ...b, [k]: !b[k] }));
  const agentSteps = run.steps.filter((s) => s.kind === 'agent').length;

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="md" aria-labelledby="save-as-title">
      <div className="p-5 flex flex-col gap-4">
        <div>
          <h2 id="save-as-title" className="m-0 text-base font-semibold text-fg-primary">
            Save as a workflow
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            Keeps these {run.steps.length} steps and their order so you can start the same thing
            again. This run stays as it is.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full min-h-11 rounded-sm bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] px-3 text-sm text-fg-primary"
          />
        </label>
        <fieldset className="m-0 p-0 border-none flex flex-col gap-2">
          <legend className="text-xs text-fg-muted mb-1">Leave blanks to fill in each time</legend>
          {(
            [
              ['topic', 'What we’re choosing', '“a feature-flag service”'],
              [
                'options',
                'Options to compare',
                '“LaunchDarkly, Unleash, GrowthBook, Flagsmith” — one step each',
              ],
              ['criteria', 'What matters', '“price at 25 seats, self-hosting, SDKs…”'],
            ] as const
          ).map(([key, label, was]) => (
            <label
              key={key}
              className="flex items-start gap-2.5 rounded-md border border-border-default px-3 py-2 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={blanks[key]}
                onChange={() => toggle(key)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm text-fg-primary">{label}</span>
                <span className="block text-[11px] text-fg-muted break-words">
                  This run used {was}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="m-0 text-[11px] text-fg-muted">
          {agentSteps} agent steps keep their profiles. No approval steps — add one later if you
          want to sign off before the report is shared.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button onClick={onSave}>
            <Bookmark size={15} /> Save workflow
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function statusLabelFor(frame: RunFrame, key: string) {
  return STEP_META[frame.steps[key]?.status ?? 'waiting'].label;
}
