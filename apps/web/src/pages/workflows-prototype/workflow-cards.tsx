/**
 * PROTOTYPE ONLY — list cards. Runs are solid and colored by state; saved
 * workflows are dashed "recipes" with a small shape diagram and no status.
 * That outline-vs-filled contrast is how the UI separates the reusable thing
 * from one time it ran, without leaning on the word "template".
 */
import { Button } from '@simple-agent-manager/ui';
import { AlertTriangle, Bookmark, CalendarClock, Hand, Play } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { getSaved } from './mock-workflows';
import {
  countSteps,
  frameAt,
  layerSteps,
  progressSentence,
  type RunDef,
  type SavedWorkflow,
  type StepDef,
} from './model';
import { p } from './shell';
import { OriginChip, RUN_META, RunStatusPill, StarterLabel, StepProgressBar } from './status-ui';

export function ShapeStrip({ steps, size = 12 }: { steps: StepDef[]; size?: number }) {
  const layers = layerSteps(steps);
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {layers.map((layer, i) => (
        <div key={layer[0]?.key ?? i} className="flex items-center gap-1">
          {i > 0 && <span className="h-px w-2.5 bg-[var(--sam-color-border-default)]" />}
          <div className="flex flex-col gap-[3px]">
            {layer.map((s) =>
              s.kind === 'approval' ? (
                <span
                  key={s.key}
                  className="rotate-45 rounded-[2px] border"
                  style={{
                    width: size - 3,
                    height: size - 3,
                    margin: 1.5,
                    borderColor: 'color-mix(in srgb, var(--sam-color-warning) 70%, transparent)',
                    background: 'color-mix(in srgb, var(--sam-color-warning) 14%, transparent)',
                  }}
                />
              ) : (
                <span
                  key={s.key}
                  className="rounded-[3px] border border-dashed"
                  style={{
                    width: size,
                    height: size,
                    borderColor: 'var(--sam-color-fg-muted)',
                    opacity: 0.75,
                  }}
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunCard({ run }: { run: RunDef }) {
  const navigate = useNavigate();
  const frame = frameAt(run, null);
  const counts = countSteps(frame, run.steps);
  const meta = RUN_META[frame.status];
  const Icon = meta.icon;
  const saved = run.origin.kind === 'saved' ? getSaved(run.origin.workflowId) : null;
  const waitingStep = run.steps.find((s) => frame.steps[s.key]?.status === 'needs_you');
  const failedStep = run.steps.find((s) => frame.steps[s.key]?.status === 'failed');
  const href = p(`b/workflows/runs/${run.id}`);

  return (
    <div
      className="rounded-lg border px-3 py-3 bg-[var(--sam-glass-nested-bg)] hover:border-accent/40 transition-colors"
      style={{
        borderColor: waitingStep
          ? 'color-mix(in srgb, var(--sam-color-warning) 60%, transparent)'
          : frame.status === 'needs_attention'
            ? 'color-mix(in srgb, var(--sam-color-danger) 45%, transparent)'
            : 'var(--sam-form-border)',
      }}
      data-testid="run-card"
    >
      <Link to={href} className="block no-underline text-inherit">
        <div className="flex items-start gap-2.5">
          <Icon
            size={17}
            className={`shrink-0 mt-0.5 ${meta.spin ? 'motion-safe:animate-spin' : ''}`}
            style={{ color: meta.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-fg-primary leading-snug line-clamp-2 break-words">
              {run.title}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted min-w-0">
              <OriginChip run={run} />
              {saved && <span className="truncate max-w-[16rem]">{saved.name}</span>}
              {run.origin.kind === 'one_off' && run.origin.chatTitle && (
                <span className="truncate max-w-[16rem]">from chat “{run.origin.chatTitle}”</span>
              )}
              <StarterLabel run={run} />
            </div>
          </div>
          <span className="hidden sm:inline-flex shrink-0">
            <RunStatusPill status={frame.status} />
          </span>
        </div>
        <StepProgressBar steps={run.steps} frame={frame} className="mt-2.5" />
        <div className="mt-1.5 text-[11px] text-fg-muted">{progressSentence(counts)}</div>
      </Link>
      {waitingStep && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span
            className="flex items-center gap-1.5 text-xs font-medium min-w-0"
            style={{ color: 'var(--sam-color-warning-fg)' }}
          >
            <Hand size={13} className="shrink-0" aria-hidden />
            <span className="truncate">
              {waitingStep.title.replace('Your approval: ', 'Approve: ')}
            </span>
          </span>
          <Button
            size="sm"
            className="ml-auto"
            style={{ background: 'var(--sam-color-warning)', color: '#1a1205' }}
            onClick={() => navigate(`${href}?step=${waitingStep.key}`)}
          >
            Review
          </Button>
        </div>
      )}
      {!waitingStep && failedStep && frame.status === 'needs_attention' && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span
            className="flex items-center gap-1.5 text-xs font-medium min-w-0"
            style={{ color: 'var(--sam-color-danger-fg)' }}
          >
            <AlertTriangle size={13} className="shrink-0" aria-hidden />
            <span className="truncate">“{failedStep.title}” failed</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={() => navigate(`${href}?step=${failedStep.key}`)}
          >
            Open step
          </Button>
        </div>
      )}
    </div>
  );
}

export function SavedCard({ wf }: { wf: SavedWorkflow }) {
  const navigate = useNavigate();
  const approvals = wf.steps.filter((s) => s.kind === 'approval').length;
  return (
    <div
      className="rounded-lg border border-dashed px-3 py-3 flex flex-col gap-2.5 min-w-0 hover:border-accent/50 transition-colors"
      style={{ borderColor: 'color-mix(in srgb, var(--sam-color-fg-muted) 45%, transparent)' }}
      data-testid="saved-card"
    >
      <Link
        to={p(`b/workflows/saved/${wf.id}`)}
        className="block no-underline text-inherit min-w-0"
      >
        <div className="flex items-start gap-2">
          <Bookmark size={16} className="shrink-0 mt-0.5 text-fg-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-fg-primary leading-snug line-clamp-2 break-words">
              {wf.name}
            </div>
            <div className="mt-0.5 text-xs text-fg-muted leading-relaxed line-clamp-2 break-words">
              {wf.description}
            </div>
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-3 pl-6 min-w-0">
        <ShapeStrip steps={wf.steps} />
        <span className="text-[11px] text-fg-muted truncate">
          {wf.steps.length} steps{approvals ? ` · ${approvals} approval` : ''}
          {wf.inputs.length
            ? ` · ${wf.inputs.length} blank${wf.inputs.length > 1 ? 's' : ''} to fill`
            : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] text-fg-muted">
        <span>
          v{wf.version} · used {wf.usedCount}×
        </span>
        {wf.lastRun && <span>last run {wf.lastRun.ago}</span>}
        {wf.schedule && (
          <span
            className="inline-flex items-center gap-1 min-w-0"
            style={{ color: 'var(--sam-color-info-fg)' }}
          >
            <CalendarClock size={11} className="shrink-0" aria-hidden />
            <span className="truncate">{wf.schedule.label}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 pl-6">
        <Button size="sm" onClick={() => navigate(p(`b/workflows/saved/${wf.id}/start`))}>
          <Play size={14} /> Start
        </Button>
        {wf.lastRun && (
          <Link
            to={p(`b/workflows/runs/${wf.lastRun.runId}`)}
            className="text-xs text-fg-muted hover:text-fg-primary inline-flex items-center gap-1"
          >
            Last run: {RUN_META[wf.lastRun.status].label}
          </Link>
        )}
      </div>
    </div>
  );
}
