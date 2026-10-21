/**
 * The run's steps as a checklist, grouped into stages ("First", "Then · at the same time",
 * "Finally"). Steps that run at the same time sit side by side when there is room, so the
 * dependency shape is visible in the list as well as in the graph.
 */
import type { WorkflowRunDetail, WorkflowStepDetail } from '@simple-agent-manager/shared';
import { CornerDownRight } from 'lucide-react';

import { explainStep, stagesOf, stageTitle, startsAfterLine, stepDuration } from './model';
import { StepMark, TONE_COLOR } from './ui';

function StepCard({
  step,
  number,
  run,
  after,
  selected,
  onSelect,
}: {
  step: WorkflowStepDetail;
  number: number;
  run: WorkflowRunDetail;
  after: string | null;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const explanation = explainStep(step, run);
  // A finished step's explanation already says how long it took; show elapsed time while it runs.
  const took = step.status === 'running' || step.status === 'starting' ? stepDuration(step) : null;
  const quiet = step.status === 'waiting' || step.status === 'blocked';
  const border = selected
    ? 'var(--sam-color-accent-primary)'
    : step.status === 'failed'
      ? 'color-mix(in srgb, var(--sam-color-danger-fg) 55%, transparent)'
      : step.status === 'running' || step.status === 'starting'
        ? 'color-mix(in srgb, var(--sam-color-success-fg) 45%, transparent)'
        : 'var(--sam-color-border-default)';
  return (
    <button
      type="button"
      data-testid="workflow-step-card"
      data-step={step.key}
      data-status={step.status}
      aria-pressed={selected}
      onClick={() => onSelect(step.key)}
      className={`flex w-full min-w-0 cursor-pointer gap-3 rounded-xl border border-solid px-3 py-3 text-left transition-colors hover:bg-surface-hover ${quiet ? 'bg-transparent' : 'glass-surface'}`}
      style={{
        borderColor: border,
        boxShadow: selected ? '0 0 0 1px var(--sam-color-accent-primary)' : undefined,
      }}
    >
      <span className="pt-0.5">
        <StepMark step={step} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-start gap-2">
          <span
            className={`line-clamp-2 min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug [overflow-wrap:anywhere] ${quiet ? 'text-fg-muted' : 'text-fg-primary'}`}
          >
            <span className="mr-1.5 tabular-nums text-fg-muted">{number}</span>
            {step.title}
          </span>
          {took && (
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-fg-muted">{took}</span>
          )}
        </span>
        {step.agent?.profileName && (
          <span className="break-words text-xs text-fg-muted">{step.agent.profileName}</span>
        )}
        <span
          className="line-clamp-3 break-words text-[13px] [overflow-wrap:anywhere]"
          style={{
            color:
              explanation.tone === 'muted'
                ? 'var(--sam-color-fg-muted)'
                : TONE_COLOR[explanation.tone],
          }}
        >
          {explanation.text}
        </span>
        {after && (
          <span className="flex items-start gap-1 text-xs text-fg-muted">
            <CornerDownRight size={12} aria-hidden className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{after}</span>
          </span>
        )}
        {step.output?.summary && (
          <span className="line-clamp-2 break-words text-[13px] text-fg-primary [overflow-wrap:anywhere]">
            {step.output.summary}
          </span>
        )}
      </span>
    </button>
  );
}

export function RunSteps({
  run,
  selectedKey,
  onSelect,
  sideBySide,
}: {
  run: WorkflowRunDetail;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Lay steps that run at the same time out next to each other. */
  sideBySide: boolean;
}) {
  const stages = stagesOf(run.steps);
  const numbers = new Map(run.steps.map((step, index) => [step.key, index + 1]));
  const titleOf = (key: string) => run.steps.find((step) => step.key === key)?.title ?? key;
  return (
    <ol
      aria-label="Steps"
      className="m-0 flex list-none flex-col gap-5 p-0"
      data-testid="workflow-steps"
    >
      {stages.map((stage, index) => {
        const title = stageTitle(index, stages.length, stage.length);
        return (
          <li key={stage.map((step) => step.key).join('|')} className="flex min-w-0 flex-col gap-2">
            {title && (
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  {title}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border-default" />
                {stage.length > 1 && run.maxParallelSteps !== null && (
                  <span className="whitespace-nowrap text-xs text-fg-muted">
                    up to {run.maxParallelSteps} at once
                  </span>
                )}
              </div>
            )}
            <div
              className={`grid min-w-0 gap-2 ${sideBySide && stage.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
            >
              {stage.map((step) => (
                <StepCard
                  key={step.key}
                  step={step}
                  number={numbers.get(step.key) ?? 0}
                  run={run}
                  after={startsAfterLine(step, stages[index - 1], titleOf)}
                  selected={selectedKey === step.key}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
