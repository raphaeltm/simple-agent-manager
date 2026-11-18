import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type { InboxItem } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { ApiClientError } from '../../../lib/api/client';
import { inboxItemQueryOptions, inboxQueryKeys } from '../../../lib/query-options/inbox';
import { useInboxPermissionDetail } from '../../inbox/inbox-actions';
import { KIND_META } from '../../inbox/inbox-model';
import { InboxAnswerControls } from '../../inbox/InboxAnswerControls';
import { inboxPath } from '../../inbox/InboxButton';
import { InboxLinkChips } from '../../inbox/InboxItemView';
import { extractInboxItemRef } from './inbox-item-card-data';

export interface InboxItemCardProps {
  item: ToolCallItem;
  /** Project of the conversation; the item is read and answered within it. */
  projectId?: string;
}

/**
 * How often an open card re-reads its item, which can be answered from the Inbox or another tab.
 * TanStack pauses this while the tab is hidden. Override via VITE_INBOX_ITEM_CARD_REFRESH_MS.
 */
const DEFAULT_INBOX_ITEM_CARD_REFRESH_MS = 15_000;
const configuredRefreshMs = Number.parseInt(
  import.meta.env.VITE_INBOX_ITEM_CARD_REFRESH_MS ?? '',
  10
);
const INBOX_ITEM_CARD_REFRESH_MS =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? configuredRefreshMs
    : DEFAULT_INBOX_ITEM_CARD_REFRESH_MS;

const CARD_CLASS = 'glass-surface my-1 rounded-md border border-border-default';

type Tone = 'open' | 'done' | 'muted';

const BADGE_CLASS: Record<Tone, string> = {
  open: 'bg-warning-tint text-warning-fg',
  done: 'bg-success/10 text-success',
  muted: 'bg-surface text-fg-muted',
};

/** Card heading and status words per kind; anything else reads as a question. */
const CARD_COPY: Record<
  'review' | 'result' | 'question',
  { heading: string; open: string | null; closed: string }
> = {
  review: { heading: 'Review requested', open: 'Waiting for your review', closed: 'Reviewed' },
  result: { heading: 'Result for you', open: 'New result', closed: 'Done' },
  // A question's open label depends on whether the agent is paused on it.
  question: { heading: 'Question for you', open: null, closed: 'Answered' },
};

function cardCopy(item: InboxItem) {
  return CARD_COPY[item.kind === 'review' || item.kind === 'result' ? item.kind : 'question'];
}

function statusFor(item: InboxItem): { label: string; tone: Tone } {
  const copy = cardCopy(item);
  switch (item.status) {
    case 'open':
      // Amber means waiting on you; a blocking ask also has the agent stopped on it.
      if (copy.open) return { label: copy.open, tone: 'open' };
      return { label: item.blocking ? 'Agent paused on this' : 'Needs your answer', tone: 'open' };
    case 'answered':
    case 'done':
      return { label: copy.closed, tone: 'done' };
    case 'archived':
      return { label: 'Archived', tone: 'muted' };
    case 'cancelled':
      return { label: 'Withdrawn by the agent', tone: 'muted' };
    case 'expired':
      return { label: 'Expired', tone: 'muted' };
  }
}

/** Missing, foreign or not addressed to this reader: the inbox answers 404 (or 403). */
function isNotInInbox(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 403);
}

/** Long reasons start collapsed, so they do not bury the answer buttons. */
const COLLAPSIBLE_BODY_CHARS = 600;

function Body({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSIBLE_BODY_CHARS;
  return (
    <div>
      <div
        className={`min-w-0 text-sm whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere] ${collapsible && !expanded ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]' : ''}`}
      >
        {/* Agent-written and untrusted: plain text, as the Inbox shows it. */}
        {text}
      </div>
      {collapsible && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

function OpenInboxLink({ item }: { item: InboxItem }) {
  return (
    <Link
      to={inboxPath(item)}
      aria-label={`Open in inbox: ${item.title}`}
      className="inline-flex min-h-11 items-center self-start text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring sm:min-h-0"
    >
      Open in inbox
    </Link>
  );
}
/** The loaded item: its question, review or result, links, and the same controls as the Inbox. */
function LoadedCard({ item, onChanged }: { item: InboxItem; onChanged: () => void }) {
  const permission = useInboxPermissionDetail(item);
  const [receipt, setReceipt] = useState<string | null>(null);
  const receiptRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (receipt) receiptRef.current?.focus();
  }, [receipt]);
  const status = statusFor(item);
  const Icon = KIND_META[item.kind]?.icon ?? Inbox;
  return (
    <div className={CARD_CLASS} data-testid="inbox-item-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg-primary">
          <Icon
            size={16}
            className={`shrink-0 ${status.tone === 'open' ? 'text-warning-fg' : 'text-fg-muted'}`}
            aria-hidden="true"
          />
          {cardCopy(item).heading}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_CLASS[status.tone]}`}
        >
          {status.label}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3">
        <p className="m-0 text-[15px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
          {item.title}
        </p>
        {item.body && item.body !== item.title && <Body text={item.body} />}
        <InboxLinkChips item={item} />
      </div>
      <div className="flex flex-col gap-2 px-4 pb-3 pt-3">
        {/* Mounted before any answer, so the receipt is announced; it takes focus when the
            controls it replaces unmount, so keyboard users keep their place. */}
        <p
          ref={receiptRef}
          role="status"
          tabIndex={-1}
          className={`m-0 text-sm text-fg-muted [overflow-wrap:anywhere] focus:outline-none ${receipt ? '' : 'sr-only'}`}
        >
          {receipt ?? ''}
        </p>
        {!receipt && item.status === 'open' && (
          <InboxAnswerControls
            item={item}
            permission={permission}
            handlers={{
              onAnswered: (text) => {
                setReceipt(text);
                onChanged();
              },
              onStale: onChanged,
            }}
          />
        )}
        <OpenInboxLink item={item} />
      </div>
    </div>
  );
}

/**
 * Renders an `inbox_write` ask, review or result as the inbox item it filed, so the person can answer it
 * in the conversation as well as from the Inbox. The card and the inbox item are two views of one
 * `asks` record: everything shown is read from the inbox, the transcript supplies only the
 * reference, and an answer in either place closes both.
 */
export const InboxItemCard: FC<InboxItemCardProps> = ({ item, projectId }) => {
  const ref = useMemo(() => extractInboxItemRef(item), [item]);
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...inboxItemQueryOptions(scope ?? '', projectId ?? '', ref?.ref ?? ''),
    enabled: Boolean(scope && projectId && ref),
    // Closed items cannot change; one that failed to load waits for Retry.
    refetchInterval: (q) =>
      q.state.data?.item.status === 'open' && !q.state.error ? INBOX_ITEM_CARD_REFRESH_MS : false,
  });

  if (!ref) return null;

  if (!projectId) {
    return (
      <div className={`${CARD_CLASS} flex items-center gap-2.5 px-3 py-2.5`} role="note">
        <Inbox size={18} className="shrink-0 text-fg-muted" aria-hidden="true" />
        <div className="min-w-0 text-sm text-fg-muted">
          The agent filed an item in your inbox. Answer it from your Inbox.
        </div>
      </div>
    );
  }

  const loaded = query.data?.item;
  if (loaded) {
    return (
      <LoadedCard
        item={loaded}
        onChanged={() => {
          if (scope) void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.all(scope) });
        }}
      />
    );
  }

  return (
    <div className={`${CARD_CLASS} flex flex-wrap items-center gap-2.5 px-3 py-2.5`}>
      {query.error ? (
        <>
          {isNotInInbox(query.error) ? (
            <div className="min-w-0 flex-1 text-sm text-fg-muted" role="status">
              This inbox item is not in your inbox.{' '}
              <Link
                to={`/projects/${projectId}/inbox`}
                className="text-accent underline-offset-2 hover:underline"
              >
                Open the project inbox
              </Link>
            </div>
          ) : (
            <div className="min-w-0 flex-1 text-sm text-danger-fg" role="alert">
              Couldn&apos;t load this inbox item: {query.error.message}
            </div>
          )}
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-2.5" role="status">
          <Spinner size="sm" />
          <span className="text-sm text-fg-muted">Loading inbox item…</span>
        </div>
      )}
    </div>
  );
};
