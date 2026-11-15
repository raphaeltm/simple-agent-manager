/** PROTOTYPE ONLY — the list and the focused item, shared by directions A and B. */
import { Button } from '@simple-agent-manager/ui';
import { ArrowRight } from 'lucide-react';
import type { Dispatch, ReactNode } from 'react';

import { AnswerControls } from './answers';
import { GroupStepper, ItemBody, ReceiptLine } from './item';
import type { InboxItem } from './mock-data';
import {
  type Action,
  ARCHIVE_RECEIPT,
  counts,
  filtered,
  groupMembers,
  nextAfter,
  type State,
  toRows,
} from './model';
import { EmptyInbox, FilterBar, InboxRow, UpdatesList } from './rows';

export function useFilterCounts(state: State) {
  const c = counts(state);
  return { all: c.all, blocking: c.blocking, tasks: c.tasks, reviews: c.reviews, updates: 4 };
}

export function Filters({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return (
    <FilterBar
      value={state.filter}
      onChange={(filter) => dispatch({ type: 'filter', filter })}
      counts={useFilterCounts(state)}
    />
  );
}

export function ListContent({
  state,
  dispatch,
  selectedId,
  onOpen,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  selectedId?: string | null;
  onOpen: (id: string) => void;
}) {
  if (state.filter === 'updates') return <UpdatesList />;
  const items = filtered(state);
  if (items.length === 0) {
    return state.filter === 'all' ? (
      <EmptyInbox onUpdates={() => dispatch({ type: 'filter', filter: 'updates' })} />
    ) : (
      <p className="m-0 px-4 py-10 text-center text-sm text-fg-muted">Nothing here.</p>
    );
  }
  return (
    <ul className="m-0 flex flex-col gap-1 p-1.5">
      {toRows(items).map((row) => (
        <InboxRow
          key={row.type === 'group' ? row.key : row.item.id}
          row={row}
          selectedId={selectedId}
          onOpen={onOpen}
          showProject={!state.scope}
        />
      ))}
    </ul>
  );
}

/**
 * Scroll area (receipt, stack stepper, the ask) over a pinned dock (the answer). After an
 * answer the dock shows the receipt and one "Next" action instead of the controls.
 */
export function ItemPane({
  state,
  dispatch,
  item,
  advanceOnAnswer,
  banner,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  item: InboxItem;
  advanceOnAnswer: boolean;
  banner?: ReactNode;
}) {
  const closed = state.archived.includes(item.id) || item.id.startsWith('arch-');
  const receipt = state.resolved[item.id] ?? (closed ? ARCHIVE_RECEIPT : undefined);
  const next = receipt && !closed ? nextAfter(state, item.id) : undefined;
  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
        <div className="flex flex-col gap-3">
          {banner}
          <GroupStepper state={state} members={groupMembers(state, item)} current={item} />
          <ItemBody
            item={item}
            state={state}
            onContext={(open) => dispatch({ type: 'context', open })}
          />
        </div>
      </div>
      {/* Capped so a tall answer (10 options, the ACP card) cannot squeeze the ask off screen. */}
      <div className="relative max-h-[55%] shrink-0 overflow-y-auto border-t border-[var(--sam-hairline)] px-4 pt-3 pb-3">
        {receipt ? (
          <div className="flex flex-col gap-3">
            <ReceiptLine text={receipt} />
            {closed ? (
              <p className="m-0 text-sm text-fg-muted">
                Closed. Answering it now would need a new ask from the agent.
              </p>
            ) : next ? (
              <Button
                className="min-h-11 w-full justify-between"
                onClick={() => dispatch({ type: 'open', id: next.id })}
              >
                <span className="min-w-0 truncate">Next: {next.title}</span>
                <ArrowRight size={16} aria-hidden="true" className="shrink-0" />
              </Button>
            ) : (
              <p className="m-0 text-sm text-fg-muted">That was the last one.</p>
            )}
          </div>
        ) : (
          <AnswerControls
            key={item.id}
            item={item}
            onAnswered={(r) =>
              dispatch({ type: 'answered', id: item.id, receipt: r, advance: advanceOnAnswer })
            }
          />
        )}
      </div>
    </>
  );
}
