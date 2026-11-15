/**
 * PROTOTYPE ONLY — Direction C: the bell panel, upgraded. The inbox is a sheet over whatever
 * you are doing; rows carry quick answers, and a row expands in place for the full ask and
 * context. No page navigation.
 */
import { Button, IconButton, paneClassName } from '@simple-agent-manager/ui';
import { ChevronDown, X } from 'lucide-react';
import { type Dispatch, useEffect, useRef } from 'react';

import { AttentionAnswerControls } from '../../components/notifications/AttentionAnswerControls';
import { AnswerControls } from './answers';
import { Filters } from './common';
import { GroupStepper, ItemBody, ReceiptLine } from './item';
import { lastAnswers } from './mock-api';
import { type InboxItem, must } from './mock-data';
import { type Action, counts, filtered, groupMembers, type Row, type State, toRows } from './model';
import { EmptyInbox, InboxRow, UpdatesList } from './rows';
import { ChatBackdrop, DesktopSidebar, Frame, MobileBar } from './shell';

type Answer = (item: InboxItem, receipt: string) => void;

/** The one-tap answer under a collapsed row, or a button that expands it when one tap is unsafe. */
function QuickAnswer({
  item,
  answer,
  expand,
}: {
  item: InboxItem;
  answer: Answer;
  expand: () => void;
}) {
  const more = (label: string) => (
    <Button size="sm" variant="secondary" className="min-h-11" onClick={expand}>
      {label}
    </Button>
  );
  switch (item.kind) {
    case 'question':
      return (item.options?.length ?? 0) <= 3 ? (
        <AttentionAnswerControls
          projectId="proj-proto"
          sessionId={`chat-${item.id}`}
          markerId={item.id}
          options={item.options ?? []}
          onResolved={() =>
            answer(item, `Sent “${lastAnswers.get(item.id) ?? ''}” · the agent woke`)
          }
        />
      ) : (
        more(`Answer (${item.options?.length} options)`)
      );
    case 'permission':
      return (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11"
            onClick={() => answer(item, 'Allowed once · the agent carried on')}
          >
            Allow once
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="min-h-11"
            onClick={() => answer(item, 'Denied · the agent was told')}
          >
            Deny
          </Button>
          <button
            type="button"
            onClick={expand}
            className="cursor-pointer border-0 bg-transparent px-1 text-[13px] text-accent"
          >
            Details
          </button>
        </div>
      );
    case 'approval':
      // Deleting something is never one tap from a list row.
      return more('Review');
    case 'secret':
      return more('Add secret');
    case 'task': {
      const done = item.steps?.filter((s) => s.done).length ?? 0;
      return (
        <div className="flex items-center gap-3">
          {more(item.team && !item.team.claimedBy ? 'Take it' : 'Open steps')}
          <span className="text-xs text-fg-muted">
            {done} of {item.steps?.length ?? 0} done
          </span>
        </div>
      );
    }
    case 'review':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="min-h-11"
            onClick={() => answer(item, 'Looks good · the agent woke')}
          >
            Looks good
          </Button>
          <Button size="sm" variant="secondary" className="min-h-11" onClick={expand}>
            Reply
          </Button>
        </div>
      );
  }
}

function CRow({ row, state, dispatch }: { row: Row; state: State; dispatch: Dispatch<Action> }) {
  const members = row.type === 'group' ? row.items : [row.item];
  const expandedMember = members.find((m) => m.id === state.openId);
  const head = expandedMember ?? must(members[0]);
  const toggle = () => dispatch({ type: 'open', id: expandedMember ? null : head.id });
  const answer: Answer = (item, receipt) =>
    dispatch({ type: 'answered', id: item.id, receipt, advance: false });
  const archive = (id: string) => dispatch({ type: 'archive', id, advance: false });
  const expandedRef = useRef<HTMLDivElement>(null);
  // Bring an expanded row's header to the top of the panel, or it opens below the fold.
  useEffect(() => {
    expandedRef.current?.parentElement?.scrollIntoView({ block: 'start' });
  }, [expandedMember?.id]);
  return (
    <InboxRow
      row={row}
      onOpen={toggle}
      trailing={
        <IconButton
          size="sm"
          label={expandedMember ? 'Collapse' : 'Expand for context'}
          aria-expanded={Boolean(expandedMember)}
          icon={<ChevronDown size={18} className={expandedMember ? 'rotate-180' : ''} />}
          onClick={toggle}
          showTooltip={false}
        />
      }
    >
      {expandedMember ? (
        <div
          ref={expandedRef}
          className="flex flex-col gap-3 border-t border-[var(--sam-hairline)] px-3 pt-3 pb-3"
        >
          <GroupStepper state={state} members={groupMembers(state, head)} current={head} />
          <ItemBody
            item={head}
            state={state}
            showMeta={false}
            showTitle={false}
            onContext={(open) => dispatch({ type: 'context', open })}
          />
          <AnswerControls item={head} onAnswered={(r) => answer(head, r)} />
          <div className="flex gap-4 text-[13px]">
            <button
              type="button"
              onClick={() => archive(head.id)}
              className="cursor-pointer border-0 bg-transparent p-0 text-fg-muted"
            >
              Archive
            </button>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-accent"
            >
              Open chat
            </button>
          </div>
        </div>
      ) : state.filter === 'archived' ? null : (
        <div className="pr-3 pb-2.5 pl-14">
          <QuickAnswer
            item={head}
            answer={answer}
            expand={() => dispatch({ type: 'open', id: head.id })}
          />
        </div>
      )}
    </InboxRow>
  );
}

function Panel({
  state,
  dispatch,
  mobile,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  mobile: boolean;
}) {
  const items = filtered(state);
  const receipt = state.lastReceipt ? state.resolved[state.lastReceipt] : undefined;
  return (
    <>
      <div className="sam-scrim fixed inset-0 z-[90]" aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Inbox"
        className={`${paneClassName('overlay')} fixed z-[100] flex flex-col overflow-hidden ${
          mobile
            ? 'inset-x-2 top-[68px] bottom-2'
            : 'top-[68px] left-[200px] max-h-[calc(100vh-84px)] w-[440px]'
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 pt-1 pr-1 pl-4">
          <h2 className="m-0 flex-1 text-[15px] font-semibold text-fg-primary">Inbox</h2>
          <IconButton label="Close inbox" icon={<X size={18} />} showTooltip={false} />
        </div>
        <div className="shrink-0 px-2 pb-2">
          <Filters state={state} dispatch={dispatch} />
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto border-t border-[var(--sam-hairline)]">
          {receipt && (
            <div className="border-b border-[var(--sam-hairline)] px-4 py-2.5">
              <ReceiptLine text={receipt} />
            </div>
          )}
          {state.filter === 'updates' ? (
            <UpdatesList />
          ) : items.length === 0 ? (
            state.filter === 'all' ? (
              <EmptyInbox onUpdates={() => dispatch({ type: 'filter', filter: 'updates' })} />
            ) : (
              <p className="m-0 px-4 py-10 text-center text-sm text-fg-muted">Nothing here.</p>
            )
          ) : (
            <ul className="m-0 flex flex-col gap-1 p-1.5">
              {toRows(items).map((row) => (
                <CRow
                  key={row.type === 'group' ? row.key : row.item.id}
                  row={row}
                  state={state}
                  dispatch={dispatch}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

export function DirectionC({
  state,
  dispatch,
  mobile,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  mobile: boolean;
}) {
  const inbox = { count: counts(state).all, active: true, onClick: () => {} };
  return (
    <Frame mobile={mobile}>
      {mobile ? (
        <MobileBar title="Acme Billing" inbox={inbox} />
      ) : (
        <DesktopSidebar inbox={inbox} current="projects" />
      )}
      <ChatBackdrop />
      <Panel state={state} dispatch={dispatch} mobile={mobile} />
    </Frame>
  );
}
