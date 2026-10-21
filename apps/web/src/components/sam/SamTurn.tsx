import { Alert } from '@simple-agent-manager/ui';
import { Check, Loader2 } from 'lucide-react';

import { RenderedMarkdown } from '../MarkdownRenderer';
import { type Action, ActionCard } from './ActionCard';
import { actionTarget, describeReads, isReadReceipt } from './sam-receipts';

export interface Turn {
  id: string;
  request_key: string;
  message: string;
  state: string;
  response: string | null;
  error: string | null;
  actions: Action[];
}

export const isActiveTurn = (turn: Turn) => turn.state === 'running' || turn.state === 'accepted';

/** Completed turns need no label; every other state is worth a word. */
function stateLabel(state: string): string | null {
  if (state === 'completed') return null;
  if (state === 'running' || state === 'accepted') return 'working';
  return state.replaceAll('_', ' ');
}

export function SamTurn({
  turn,
  projectNames,
  refresh,
}: {
  turn: Turn;
  projectNames: ReadonlyMap<string, string>;
  refresh: () => Promise<unknown>;
}) {
  const reads = turn.actions.filter(isReadReceipt);
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
        {turn.response && <RenderedMarkdown content={turn.response} inline />}
        {turn.error && (
          <Alert variant="warning" className="mt-2">
            {turn.error}
          </Alert>
        )}
        {isActiveTurn(turn) && (
          <p className="mt-2 inline-flex items-center gap-2 text-sm text-fg-muted" role="status">
            <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
            Working… You can leave this page and return.
          </p>
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
}
