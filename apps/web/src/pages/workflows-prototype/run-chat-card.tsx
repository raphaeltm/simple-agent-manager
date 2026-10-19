/**
 * PROTOTYPE ONLY — the run card an agent's `start_workflow_run` tool call
 * renders in the transcript. In production it would be a typed tool card
 * registered next to DocumentCard (tool-cards/matchToolCard), so it renders in
 * any harness's chat. Same glass-surface geometry as ToolCallGroupCard.
 */
import { Button } from '@simple-agent-manager/ui';
import { ArrowUpRight, RotateCcw, SkipForward, Workflow } from 'lucide-react';
import { Link } from 'react-router';

import { countSteps, progressSentence, type RunDef, type RunFrame } from './model';
import { p } from './shell';
import { RunStatusPill, STEP_META, StepIcon, StepProgressBar } from './status-ui';

export function RunChatCard({
  run,
  frame,
  onRetry,
  onSkip,
  maxRows = 6,
}: {
  run: RunDef;
  frame: RunFrame;
  onRetry?: () => void;
  onSkip?: () => void;
  maxRows?: number;
}) {
  const counts = countSteps(frame, run.steps);
  const failed = run.steps.find((s) => frame.steps[s.key]?.status === 'failed');
  const rows = run.steps.slice(0, maxRows);
  const href = p(`b/workflows/runs/${run.id}?t=${frame.id}`);

  return (
    <div
      className="glass-surface rounded-lg border border-border-default w-full sm:max-w-[min(80%,560px)] overflow-hidden"
      data-testid="run-chat-card"
    >
      <div className="px-3 pt-2.5 pb-2 flex items-start gap-2.5">
        <span
          className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center"
          style={{
            background: 'color-mix(in srgb, var(--sam-color-accent-primary) 16%, transparent)',
            color: 'var(--sam-color-accent-primary)',
          }}
        >
          <Workflow size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-fg-muted">
            {run.origin.kind === 'one_off' ? 'One-off run started' : 'Run started'} ·{' '}
            {run.steps.length} steps · up to {run.maxParallel} at once
          </div>
          <div className="text-sm font-semibold text-fg-primary leading-snug break-words">
            {run.title}
          </div>
        </div>
        <RunStatusPill status={frame.status} />
      </div>
      <div className="px-3 pb-2.5">
        <StepProgressBar steps={run.steps} frame={frame} />
        <div className="mt-1.5 text-[11px] text-fg-muted">{progressSentence(counts)}</div>
        <ul className="list-none m-0 p-0 mt-2 flex flex-col gap-1">
          {rows.map((s) => {
            const st = frame.steps[s.key]?.status ?? 'waiting';
            return (
              <li key={s.key} className="flex items-center gap-2 text-xs min-w-0">
                <StepIcon status={st} size={13} />
                <span
                  className={`truncate ${['waiting', 'up_next'].includes(st) ? 'text-fg-muted' : 'text-fg-primary'}`}
                >
                  {s.title}
                </span>
                <span
                  className="ml-auto shrink-0 text-[11px]"
                  style={{ color: STEP_META[st].color }}
                >
                  {STEP_META[st].label}
                </span>
              </li>
            );
          })}
          {run.steps.length > maxRows && (
            <li className="text-[11px] text-fg-muted">+{run.steps.length - maxRows} more</li>
          )}
        </ul>
      </div>
      <div className="px-3 py-2 border-t border-border-default flex flex-wrap items-center gap-2">
        <Link
          to={href}
          className="inline-flex items-center gap-1 text-xs font-semibold no-underline"
          style={{ color: 'var(--sam-color-accent-primary)' }}
        >
          Open run <ArrowUpRight size={13} />
        </Link>
        {failed && onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry} className="ml-auto">
            <RotateCcw size={13} /> Retry
          </Button>
        )}
        {failed && onSkip && (
          <Button size="sm" variant="ghost" onClick={onSkip}>
            <SkipForward size={13} /> Skip
          </Button>
        )}
        {!failed && (
          <span className="ml-auto text-[11px] text-fg-muted">
            Pause or cancel any time from the run
          </span>
        )}
      </div>
    </div>
  );
}
