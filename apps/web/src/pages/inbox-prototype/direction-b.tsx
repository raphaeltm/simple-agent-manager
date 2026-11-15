/**
 * PROTOTYPE ONLY — Direction B: one at a time. Opens on the most important open item;
 * answering moves straight to the next. The list is secondary, behind a toggle.
 */
import { IconButton, Pane } from '@simple-agent-manager/ui';
import { Archive, Inbox, List, MessageSquare } from 'lucide-react';
import type { Dispatch } from 'react';

import { GlassSheet, GlassSheetHeader } from '../../components/shell/GlassSheet';
import { Filters, ItemPane, ListContent } from './common';
import { ReceiptLine } from './item';
import { type Action, counts, findItem, nextAfter, queue, type State, toRows } from './model';
import { EmptyInbox, InboxRow } from './rows';
import { DesktopSidebar, Frame, MobileBar } from './shell';

function currentItem(state: State) {
  const q = queue(state);
  const item = findItem(state.openId) ?? q[0];
  // B never rests on an answered item: it has already moved on.
  if (item && state.resolved[item.id]) return nextAfter(state, item.id);
  return item;
}

function Focus({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const q = queue(state);
  const item = currentItem(state);
  const receipt = state.lastReceipt ? state.resolved[state.lastReceipt] : undefined;
  if (!item) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        {receipt && (
          <div className="px-4">
            <ReceiptLine text={receipt} />
          </div>
        )}
        <EmptyInbox onUpdates={() => dispatch({ type: 'filter', filter: 'updates' })} />
      </div>
    );
  }
  const index = q.findIndex((i) => i.id === item.id);
  const next = q[index + 1];
  const banner = (
    <>
      {receipt && <ReceiptLine text={receipt} />}
      <div className="flex items-center gap-1">
        <span className="flex-1 text-xs text-fg-muted">
          <span className="font-mono text-fg-secondary">{index + 1}</span> of {q.length} need you
        </span>
        {next && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'open', id: next.id })}
            className="min-h-9 cursor-pointer border-0 bg-transparent px-2 text-[13px] text-accent"
          >
            Skip
          </button>
        )}
        <IconButton
          size="sm"
          label="Archive"
          icon={<Archive size={16} />}
          onClick={() => dispatch({ type: 'archive', id: item.id, advance: true })}
          showTooltip={false}
        />
        <IconButton
          size="sm"
          label="Open chat"
          icon={<MessageSquare size={16} />}
          showTooltip={false}
        />
      </div>
    </>
  );
  return <ItemPane state={state} dispatch={dispatch} item={item} advanceOnAnswer banner={banner} />;
}

function ListSheet({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  if (!state.listOpen) return null;
  const close = () => dispatch({ type: 'list', open: false });
  return (
    <GlassSheet
      label="All inbox items"
      onBackdropClick={close}
      animated={false}
      widthClassName="w-[88vw] max-w-[380px] md:w-[400px]"
    >
      <GlassSheetHeader icon={<Inbox size={18} />} title="All items" onClose={close}>
        <div className="pt-1">
          <Filters state={state} dispatch={dispatch} />
        </div>
      </GlassSheetHeader>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <ListContent
          state={state}
          dispatch={dispatch}
          selectedId={currentItem(state)?.id}
          onOpen={(id) => {
            dispatch({ type: 'open', id });
            dispatch({ type: 'list', open: false });
          }}
        />
      </div>
    </GlassSheet>
  );
}

export function DirectionB({
  state,
  dispatch,
  mobile,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  mobile: boolean;
}) {
  const badge = counts(state).all;
  const inbox = { count: badge, active: true, onClick: () => dispatch({ type: 'open', id: null }) };
  const listToggle = (
    <IconButton
      raised
      label={`All items, ${badge}`}
      icon={<List size={20} />}
      count={badge || undefined}
      countTone="attention"
      aria-expanded={state.listOpen}
      onClick={() => dispatch({ type: 'list', open: !state.listOpen })}
      showTooltip={false}
      className="ml-1"
    />
  );

  if (mobile) {
    return (
      <Frame mobile>
        <MobileBar title="Inbox" inbox={inbox} right={listToggle} />
        <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
          <Focus state={state} dispatch={dispatch} />
        </Pane>
        <ListSheet state={state} dispatch={dispatch} />
      </Frame>
    );
  }

  const q = queue(state);
  const current = currentItem(state);
  const upNext = q.slice(Math.max(0, q.findIndex((i) => i.id === current?.id) + 1)).slice(0, 5);
  return (
    <Frame mobile={false}>
      <DesktopSidebar inbox={inbox} />
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] gap-[var(--sam-space-gutter)]">
        <Pane className="flex min-h-0 flex-col items-center rounded-[var(--sam-radius-pane)]">
          <div className="flex min-h-0 w-full max-w-[680px] flex-1 flex-col pt-3">
            <Focus state={state} dispatch={dispatch} />
          </div>
        </Pane>
        <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <h2 className="m-0 text-[15px] font-semibold text-fg-primary">Up next</h2>
            <button
              type="button"
              onClick={() => dispatch({ type: 'list', open: true })}
              className="cursor-pointer border-0 bg-transparent text-[13px] text-accent"
            >
              All {badge}
            </button>
          </div>
          <ul className="relative m-0 flex min-h-0 flex-col gap-1 overflow-y-auto p-1.5">
            {toRows(upNext).map((row) => (
              <InboxRow
                key={row.type === 'group' ? row.key : row.item.id}
                row={row}
                onOpen={(id) => dispatch({ type: 'open', id })}
              />
            ))}
            {upNext.length === 0 && (
              <p className="m-0 px-3 py-4 text-sm text-fg-muted">Nothing after this one.</p>
            )}
          </ul>
        </Pane>
      </div>
      <ListSheet state={state} dispatch={dispatch} />
    </Frame>
  );
}
