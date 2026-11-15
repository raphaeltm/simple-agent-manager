/**
 * PROTOTYPE ONLY — Direction A: triage list plus focused item.
 * Phone: the list; tapping a row opens the item full screen with previous / next.
 * Desktop: list and item side by side.
 */
import { IconButton, Pane } from '@simple-agent-manager/ui';
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import type { Dispatch } from 'react';

import { Filters, ItemPane, ListContent } from './common';
import { ReceiptLine } from './item';
import { type Action, counts, findItem, groupMembers, queue, type State } from './model';
import { DesktopSidebar, Frame, MobileBar } from './shell';

/**
 * Previous / next. Inside a stack the item shows "2 of 3 from Ship billing", so the global
 * "4/9" is dropped: two counters on one screen read as a contradiction.
 */
export function Stepper({
  state,
  dispatch,
  id,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  id: string;
}) {
  const q = queue(state);
  const i = q.findIndex((it) => it.id === id);
  const item = findItem(id);
  const inStack = Boolean(item && groupMembers(state, item).length > 1);
  return (
    <>
      <IconButton
        label="Previous"
        icon={<ChevronLeft size={20} />}
        disabled={i <= 0}
        onClick={() => dispatch({ type: 'open', id: q[i - 1]?.id ?? null })}
        showTooltip={false}
      />
      {!inStack && (
        <span className="font-mono text-xs text-fg-muted">
          {i >= 0 ? `${i + 1}/${q.length}` : '✓'}
        </span>
      )}
      <IconButton
        label="Next"
        icon={<ChevronRight size={20} />}
        disabled={i < 0 || i >= q.length - 1}
        onClick={() => dispatch({ type: 'open', id: q[i + 1]?.id ?? null })}
        showTooltip={false}
      />
    </>
  );
}

export function ItemActions({ dispatch, id }: { dispatch: Dispatch<Action>; id: string }) {
  return (
    <>
      <IconButton
        label="Archive"
        icon={<Archive size={18} />}
        onClick={() => dispatch({ type: 'archive', id, advance: true })}
        showTooltip={false}
      />
      <IconButton label="Open chat" icon={<MessageSquare size={18} />} showTooltip={false} />
    </>
  );
}

/**
 * After an answer the walk moves straight on (B's behaviour): the previous item's receipt is
 * one line above the next ask instead of a "Next" button.
 */
export function AdvanceReceipt({ state, item }: { state: State; item: { id: string } }) {
  const last = state.lastReceipt;
  if (!last || last === item.id) return null;
  const text = state.resolved[last];
  return text ? (
    <div className="-mx-4 -mt-3 border-b border-[var(--sam-hairline)] bg-success-tint px-4 py-2">
      <ReceiptLine text={text} />
    </div>
  ) : null;
}

export function DirectionA({
  state,
  dispatch,
  mobile,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  mobile: boolean;
}) {
  const badge = counts(state).all;
  const open = (id: string) => dispatch({ type: 'open', id });
  const inbox = { count: badge, active: true, onClick: () => dispatch({ type: 'open', id: null }) };

  if (mobile) {
    const item = findItem(state.openId);
    if (item) {
      return (
        <Frame mobile>
          <Pane as="header" variant="slab" className="flex h-14 shrink-0 items-center gap-0.5 px-1">
            <IconButton
              label="Back to inbox"
              icon={<ArrowLeft size={20} />}
              onClick={() => open('')}
              showTooltip={false}
            />
            <span className="flex flex-1 items-center justify-center">
              <Stepper state={state} dispatch={dispatch} id={item.id} />
            </span>
            <ItemActions dispatch={dispatch} id={item.id} />
          </Pane>
          <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
            <ItemPane
              state={state}
              dispatch={dispatch}
              item={item}
              advanceOnAnswer
              banner={<AdvanceReceipt state={state} item={item} />}
            />
          </Pane>
        </Frame>
      );
    }
    return (
      <Frame mobile>
        <MobileBar title="Inbox" inbox={inbox} />
        <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
          <div className="shrink-0 px-2 pt-2 pb-1.5">
            <Filters state={state} dispatch={dispatch} />
          </div>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <ListContent state={state} dispatch={dispatch} onOpen={open} />
          </div>
        </Pane>
      </Frame>
    );
  }

  const q = queue(state);
  const item = findItem(state.openId) ?? (state.filter === 'updates' ? undefined : q[0]);
  return (
    <Frame mobile={false}>
      <DesktopSidebar inbox={inbox} />
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
        <Pane
          as="header"
          variant="slab"
          className="flex flex-col gap-3 rounded-[var(--sam-radius-slab)] px-5 py-4"
        >
          <div>
            <h1 className="m-0 text-2xl font-bold text-fg-primary">Inbox</h1>
            <p className="m-0 mt-0.5 text-sm text-fg-muted">
              Everything your agents need from you, across projects.
            </p>
          </div>
          <Filters state={state} dispatch={dispatch} />
        </Pane>
        <div className="grid min-h-0 grid-cols-[400px_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
          <Pane className="relative min-h-0 overflow-y-auto rounded-[var(--sam-radius-pane)]">
            <ListContent state={state} dispatch={dispatch} selectedId={item?.id} onOpen={open} />
          </Pane>
          <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
            {item ? (
              <>
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--sam-hairline)] px-2 py-1">
                  <span className="flex items-center">
                    <Stepper state={state} dispatch={dispatch} id={item.id} />
                  </span>
                  <span className="flex items-center">
                    <ItemActions dispatch={dispatch} id={item.id} />
                  </span>
                </div>
                <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col">
                  <ItemPane
                    state={state}
                    dispatch={dispatch}
                    item={item}
                    advanceOnAnswer
                    banner={<AdvanceReceipt state={state} item={item} />}
                  />
                </div>
              </>
            ) : (
              <p className="m-auto text-sm text-fg-muted">Pick an item to see it here.</p>
            )}
          </Pane>
        </div>
      </div>
    </Frame>
  );
}
