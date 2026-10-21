import { Alert } from '@simple-agent-manager/ui';
import { Check } from 'lucide-react';
import { memo } from 'react';

import { RenderedMarkdown } from '../MarkdownRenderer';
import { type Action, ActionCard } from './ActionCard';
import { LiveProgress } from './LiveProgress';
import type { LiveSnapshot, LiveView } from './sam-live';
import { actionTarget, describeReads, isReadReceipt } from './sam-receipts';

export interface Turn {
  id: string;
  request_key: string;
  message: string;
  state: string;
  response: string | null;
  error: string | null;
  actions: Action[];
  /** Server epoch milliseconds. */
  created_at?: number;
  /** Progress of the running turn, carried by polled history (the stream supersedes it). */
  live?: LiveSnapshot;
}

export const isActiveTurn = (turn: Turn) => turn.state === 'running' || turn.state === 'accepted';

/** Completed turns need no label; every other state is worth a word. */
function stateLabel(state: string): string | null {
  if (state === 'completed' || state === 'running' || state === 'accepted') return null;
  return state.replaceAll('_', ' ');
}

/**
 * Memoized: while a turn streams, live updates re-render the conversation many times a
 * second, and only the running turn's props change.
 */
export const SamTurn = memo(function SamTurn({
  turn,
  projectNames,
  refresh,
  live = null,
}: {
  turn: Turn;
  projectNames: ReadonlyMap<string, string>;
  refresh: () => Promise<unknown>;
  /** Live view of this turn while it runs. */
  live?: LiveView | null;
}) {
  const active = isActiveTurn(turn);
  // While running, the live step list says the same thing as the read summary, sooner.
  const reads = active ? [] : turn.actions.filter(isReadReceipt);
  const effects = turn.actions.filter((action) => !isReadReceipt(action));
  const label = stateLabel(turn.state);
  return (
    <article className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <div className="flex justify-end">
        <div className="glass-msg-user min-w-0 max-w-[85%] rounded-lg px-4 py-3">
          <span className="sr-only">You: </span>
          <p className="whitespace-pre-wrap">{turn.message}</p>
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg-muted">SAM{label ? ` · ${label}` : ''}</p>
        {active && (
          <LiveProgress view={live} startedAt={turn.created_at} projectNames={projectNames} />
        )}
        {turn.response && <RenderedMarkdown content={turn.response} inline />}
        {turn.error && (
          <Alert variant="warning" className="mt-2">
            {turn.error}
          </Alert>
        )}
        {reads.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-fg-muted">
            <Check size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
            Checked {describeReads(reads)}
          </p>
        )}
        {effects.map((action) => {
          const projectId = actionTarget(action)?.projectId;
          return (
            <ActionCard
              key={action.id}
              action={action}
              projectName={projectId ? projectNames.get(projectId) : undefined}
              refresh={refresh}
            />
          );
        })}
      </div>
    </article>
  );
});
