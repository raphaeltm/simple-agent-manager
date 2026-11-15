/**
 * PROTOTYPE ONLY — the desktop bell popover. C's one-tap answers survive only here, and only
 * where one tap is safe: a question with at most three short options, Allow / Deny on a live
 * permission, and "Looks good" on a review. Everything else is a plain row that opens the
 * item in the full inbox. On a phone the bell opens the full inbox instead (no popover).
 */
import { Button, IconButton, paneClassName } from '@simple-agent-manager/ui';
import { ArrowRight, X } from 'lucide-react';
import type { Dispatch } from 'react';

import { AttentionAnswerControls } from '../../../components/notifications/AttentionAnswerControls';
import { ReceiptLine } from '../item';
import { lastAnswers } from '../mock-api';
import { type InboxItem, must } from '../mock-data';
import { type Action, actionable, type State, toRows } from '../model';
import { InboxRow } from '../rows';

/** Options longer than this would wrap a quick-answer button onto two lines. */
const SHORT_OPTION_CHARS = 24;
const MAX_QUICK_OPTIONS = 3;
/** The popover lists this many rows, then "Open inbox". */
const POPOVER_ROWS = 6;

function quickSafe(item: InboxItem): boolean {
  if (item.kind === 'permission' || item.kind === 'review') return true;
  if (item.kind !== 'question') return false;
  const options = item.options ?? [];
  return (
    options.length > 0 &&
    options.length <= MAX_QUICK_OPTIONS &&
    options.every((o) => o.length <= SHORT_OPTION_CHARS)
  );
}

function Quick({ item, answer }: { item: InboxItem; answer: (receipt: string) => void }) {
  if (item.kind === 'question') {
    return (
      <AttentionAnswerControls
        projectId="proj-proto"
        sessionId={`chat-${item.id}`}
        markerId={item.id}
        options={item.options ?? []}
        onResolved={() => answer(`Sent “${lastAnswers.get(item.id) ?? ''}” · the agent woke`)}
      />
    );
  }
  if (item.kind === 'permission') {
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          className="min-h-9"
          onClick={() => answer('Allowed once · the agent carried on')}
        >
          Allow once
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="min-h-9"
          onClick={() => answer('Denied · the agent was told')}
        >
          Deny
        </Button>
      </div>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className="min-h-9"
      onClick={() => answer('Looks good · the agent was told')}
    >
      Looks good
    </Button>
  );
}

export function BellPopover({
  state,
  dispatch,
  onClose,
  onOpenItem,
  onOpenInbox,
}: {
  /** The inbox state with scope cleared: the bell is cross-project. */
  state: State;
  dispatch: Dispatch<Action>;
  onClose: () => void;
  onOpenItem: (item: InboxItem) => void;
  onOpenInbox: () => void;
}) {
  const items = actionable(state);
  const rows = toRows(items).slice(0, POPOVER_ROWS);
  const receipt = state.lastReceipt ? state.resolved[state.lastReceipt] : undefined;
  return (
    <>
      <button
        type="button"
        aria-label="Close inbox"
        onClick={onClose}
        className="fixed inset-0 z-[90] cursor-default border-0 bg-black/25"
      />
      <div
        role="dialog"
        aria-label="Inbox"
        data-testid="bell-popover"
        className={`${paneClassName('overlay')} fixed top-[60px] left-[150px] z-[100] flex max-h-[calc(100vh-76px)] w-[420px] flex-col overflow-hidden`}
      >
        <div className="flex shrink-0 items-center gap-2 pt-1 pr-1 pl-4">
          <h2 className="m-0 flex flex-1 items-center gap-2 text-[15px] font-semibold text-fg-primary">
            Inbox
            <span className="font-mono text-[13px] font-medium text-warning-fg">
              {items.length}
            </span>
            <span className="text-xs font-normal text-fg-muted">all projects</span>
          </h2>
          <IconButton
            label="Close inbox"
            icon={<X size={18} />}
            onClick={onClose}
            showTooltip={false}
          />
        </div>
        {receipt && (
          <div className="border-y border-[var(--sam-hairline)] px-4 py-2">
            <ReceiptLine text={receipt} />
          </div>
        )}
        <ul className="m-0 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
          {rows.map((row) => {
            const head = row.type === 'group' ? must(row.items[0]) : row.item;
            return (
              <InboxRow
                key={row.type === 'group' ? row.key : row.item.id}
                row={row}
                onOpen={() => onOpenItem(head)}
              >
                {row.type === 'item' && quickSafe(head) && (
                  <div className="pr-3 pb-2.5 pl-14">
                    <Quick
                      item={head}
                      answer={(r) =>
                        dispatch({ type: 'answered', id: head.id, receipt: r, advance: false })
                      }
                    />
                  </div>
                )}
              </InboxRow>
            );
          })}
        </ul>
        <div className="shrink-0 border-t border-[var(--sam-hairline)] p-2">
          <Button
            variant="secondary"
            className="min-h-10 w-full justify-between"
            onClick={onOpenInbox}
          >
            Open inbox
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </>
  );
}
