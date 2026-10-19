/**
 * PROTOTYPE ONLY — the run checklist. Steps are grouped into recipe-style
 * stages ("First", "Then · at the same time", "Finally"); parallel stages sit
 * side by side on desktop so "at the same time" is visible, not just stated.
 * No indentation or chevrons (the chat-list feedback in knowledge ChatListDesign).
 */
import { Button } from '@simple-agent-manager/ui';
import { CornerDownRight, Hand, RotateCcw, SkipForward } from 'lucide-react';

import {
  afterLine,
  layerLabel,
  layerSteps,
  type RunDef,
  type RunFrame,
  type StepDef,
} from './model';
import { EvidenceChip, ProfileChip, STEP_META, StepIcon } from './status-ui';

function rowTone(status: string, selected: boolean) {
  if (selected) {
    return {
      border: 'var(--sam-color-accent-primary)',
      background:
        'color-mix(in srgb, var(--sam-color-accent-primary) 8%, var(--sam-color-bg-surface))',
      shadow: '0 0 0 1px var(--sam-color-accent-primary)',
    };
  }
  switch (status) {
    case 'needs_you':
      return {
        border: 'color-mix(in srgb, var(--sam-color-warning) 70%, transparent)',
        background: 'color-mix(in srgb, var(--sam-color-warning) 9%, var(--sam-color-bg-surface))',
        shadow: '0 0 18px -6px color-mix(in srgb, var(--sam-color-warning) 55%, transparent)',
      };
    case 'failed':
    case 'rejected':
      return {
        border: 'color-mix(in srgb, var(--sam-color-danger) 55%, transparent)',
        background: 'color-mix(in srgb, var(--sam-color-danger) 7%, var(--sam-color-bg-surface))',
        shadow: 'none',
      };
    case 'running':
    case 'starting':
      return {
        border: 'color-mix(in srgb, var(--sam-color-success) 45%, transparent)',
        background: 'var(--sam-color-bg-surface)',
        shadow: '0 0 14px -8px color-mix(in srgb, var(--sam-color-success) 70%, transparent)',
      };
    case 'waiting':
    case 'up_next':
    case 'cancelled':
    case 'skipped':
    case 'blocked':
      return {
        border: 'var(--sam-color-border-default)',
        background: 'color-mix(in srgb, var(--sam-color-bg-surface) 55%, transparent)',
        shadow: 'none',
      };
    default:
      return {
        border: 'var(--sam-color-border-default)',
        background: 'var(--sam-color-bg-surface)',
        shadow: 'none',
      };
  }
}

export function StepRow({
  step,
  number,
  frame,
  after,
  selected,
  onSelect,
  onDecide,
  onRetry,
  onSkip,
}: {
  step: StepDef;
  number: number;
  frame: RunFrame;
  after: string | null;
  selected: boolean;
  onSelect: (key: string) => void;
  onDecide?: () => void;
  onRetry?: () => void;
  onSkip?: () => void;
}) {
  const state = frame.steps[step.key] ?? { status: 'waiting' as const };
  const meta = STEP_META[state.status];
  const tone = rowTone(state.status, selected);
  const quiet = ['waiting', 'up_next', 'cancelled', 'skipped', 'blocked'].includes(state.status);

  return (
    <div
      className="rounded-lg border transition-colors"
      style={{ borderColor: tone.border, background: tone.background, boxShadow: tone.shadow }}
      data-step={step.key}
      data-status={state.status}
    >
      <button
        type="button"
        onClick={() => onSelect(step.key)}
        className="w-full text-left bg-transparent border-none cursor-pointer px-3 py-2.5 flex gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
        aria-pressed={selected}
      >
        <span className="pt-0.5">
          <StepIcon status={state.status} size={17} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-start gap-2">
            <span
              className={`text-sm font-medium leading-snug break-words line-clamp-2 ${quiet ? 'text-fg-muted' : 'text-fg-primary'}`}
            >
              <span className="tabular-nums text-fg-muted mr-1.5">{number}</span>
              {step.title}
            </span>
            {state.duration && (
              <span className="ml-auto shrink-0 text-[11px] text-fg-muted tabular-nums pt-0.5">
                {state.duration}
              </span>
            )}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
            {step.kind === 'approval' ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 font-medium"
                style={{
                  borderColor: 'color-mix(in srgb, var(--sam-color-warning) 55%, transparent)',
                  color: 'var(--sam-color-warning-fg)',
                }}
              >
                <Hand size={11} aria-hidden /> Approval step
              </span>
            ) : (
              <ProfileChip profileId={step.profileId} />
            )}
            <span className="font-semibold" style={{ color: meta.color }}>
              {meta.label}
            </span>
            {state.reason && <span className="break-words">{state.reason}</span>}
          </span>
          {after && (
            <span className="mt-1 flex items-center gap-1 text-[11px] text-fg-muted">
              <CornerDownRight size={11} aria-hidden /> {after}
            </span>
          )}
          {state.summary && (
            <span
              className="mt-1.5 block text-xs leading-relaxed text-fg-primary/90 line-clamp-2 break-words"
              style={{ opacity: quiet ? 0.7 : 1 }}
            >
              {state.summary}
            </span>
          )}
          {state.evidence && state.evidence.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {state.evidence.map((e) => (
                <EvidenceChip key={e.label} e={e} />
              ))}
            </span>
          )}
          {state.decidedBy && (
            <span className="mt-1.5 block text-xs text-fg-muted">
              {state.status === 'approved' ? 'Approved' : 'Declined'} by {state.decidedBy}
              {state.comment ? ` — “${state.comment}”` : ''}
            </span>
          )}
        </span>
      </button>
      {(state.status === 'needs_you' && onDecide) ||
      (state.status === 'failed' && (onRetry || onSkip)) ? (
        <div className="flex flex-wrap gap-2 px-3 pb-3 pl-[38px]">
          {state.status === 'needs_you' && onDecide && (
            <Button
              size="sm"
              onClick={onDecide}
              style={{ background: 'var(--sam-color-warning)', color: '#1a1205' }}
            >
              <Hand size={14} /> Review and decide
            </Button>
          )}
          {state.status === 'failed' && onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RotateCcw size={14} /> Retry with changes
            </Button>
          )}
          {state.status === 'failed' && onSkip && (
            <Button size="sm" variant="ghost" onClick={onSkip}>
              <SkipForward size={14} /> Skip
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RunChecklist({
  run,
  frame,
  selectedKey,
  onSelect,
  onDecide,
  onRetry,
  onSkip,
  sideBySide,
}: {
  run: RunDef;
  frame: RunFrame;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onDecide?: () => void;
  onRetry?: () => void;
  onSkip?: () => void;
  sideBySide: boolean;
}) {
  const layers = layerSteps(run.steps);
  const order = new Map(layers.flat().map((s, i) => [s.key, i + 1]));

  return (
    <ol className="flex flex-col gap-4 list-none p-0 m-0" aria-label="Steps">
      {layers.map((layer, li) => (
        <li key={layer.map((s) => s.key).join('-')} className="min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted whitespace-nowrap">
              {layerLabel(li, layers.length, layer)}
            </span>
            <span className="h-px flex-1 bg-[linear-gradient(90deg,var(--sam-color-border-default),transparent)]" />
            {layer.length > 1 && (
              <span className="text-[10px] text-fg-muted whitespace-nowrap">
                {layer.length} steps · up to {run.maxParallel} at once
              </span>
            )}
          </div>
          <div
            className={`grid gap-2 min-w-0 ${sideBySide && layer.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
          >
            {layer.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                number={order.get(step.key) ?? 0}
                frame={frame}
                after={afterLine(step, layers[li - 1], run.steps)}
                selected={selectedKey === step.key}
                onSelect={onSelect}
                onDecide={onDecide}
                onRetry={onRetry}
                onSkip={onSkip}
              />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
