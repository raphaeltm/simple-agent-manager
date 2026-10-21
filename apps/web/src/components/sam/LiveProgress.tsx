import { AlertTriangle, Check, CircleDashed, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { RenderedMarkdown } from '../MarkdownRenderer';
import type { LiveActivity, LivePhase, LiveView } from './sam-live';
import { describeLiveStep } from './sam-receipts';

/** The elapsed counter shows whole seconds. */
const ELAPSED_TICK_MS = 1_000;

const PHASE_WORDS: Record<LivePhase, string> = {
  starting: 'Starting',
  thinking: 'Thinking',
  working: 'Working',
  writing: 'Writing',
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Ticks on its own so the conversation does not re-render every second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatElapsed(now - since)}</span>;
}

function StepIcon({ state }: { state: LiveActivity['state'] }) {
  if (state === 'running')
    return (
      <Loader2 size={12} aria-hidden="true" className="mt-0.5 shrink-0 motion-safe:animate-spin" />
    );
  if (state === 'completed')
    return <Check size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />;
  if (state === 'failed')
    return (
      <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-warning-fg" />
    );
  return <CircleDashed size={12} aria-hidden="true" className="mt-0.5 shrink-0" />;
}

/**
 * What SAM is doing in the running turn: phase and elapsed time, each step in plain
 * words as it starts and settles, the answer as it is written, and the latest sentence of
 * its reasoning while it thinks. Everything here is replaced by the stored answer and
 * receipts when the turn ends.
 */
export function LiveProgress({
  view,
  startedAt,
  projectNames,
}: {
  view: LiveView | null;
  /** When the turn was accepted, for the counter when no live view is available. */
  startedAt?: number;
  projectNames: ReadonlyMap<string, string>;
}) {
  const phase = view?.phase ?? 'starting';
  const since = view?.startedAt ?? startedAt;
  // Steps waiting for the user or with an unconfirmed outcome get their own action card
  // with controls below; repeating them here without controls would say it twice.
  const steps = (view?.activity ?? []).filter(
    (step) => step.state !== 'needs_approval' && step.state !== 'uncertain'
  );
  return (
    <div className="mt-1 min-w-0 space-y-2">
      <p className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
        <Loader2 size={14} aria-hidden="true" className="shrink-0 motion-safe:animate-spin" />
        {/* The phase only: the step list below says which step is running. */}
        <span role="status">{PHASE_WORDS[phase]}</span>
        {since !== undefined && (
          <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span aria-hidden="true">·</span>
            <Elapsed since={since} />
          </span>
        )}
      </p>
      {steps.length > 0 && (
        <ul aria-label="What SAM is doing" className="space-y-1">
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-start gap-1.5 text-xs text-fg-muted">
              <StepIcon state={step.state} />
              <span className="min-w-0 break-words">{describeLiveStep(step, projectNames)}</span>
            </li>
          ))}
        </ul>
      )}
      {view?.thinking && phase === 'thinking' && (
        <p className="line-clamp-2 break-words text-sm italic text-fg-muted">{view.thinking}</p>
      )}
      {view?.text ? (
        <RenderedMarkdown content={view.text} inline />
      ) : (
        !steps.length && (
          <p className="text-xs text-fg-muted">You can leave this page and come back.</p>
        )
      )}
    </div>
  );
}
