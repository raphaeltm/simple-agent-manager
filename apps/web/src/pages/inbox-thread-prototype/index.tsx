/**
 * PROTOTYPE ONLY: /prototype/inbox-thread?scene=<scene>. An inbox item as a short conversation
 * with the agent that filed it: ask it to clarify, answer in your own words, add follow-ups,
 * ask about a secret it requested. Built from the real inbox components with mock data.
 * Never ship to production.
 */
import type { InboxItem } from '@simple-agent-manager/shared';
import { Button, IconButton, Pane } from '@simple-agent-manager/ui';
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Inbox as InboxIcon,
  MessageSquare,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router';

import { buildRows } from '../../components/inbox/inbox-model';
import { InboxFilterBar } from '../../components/inbox/InboxFilterBar';
import { InboxRow } from '../../components/inbox/InboxRow';
import { SecretRequestForm } from '../../components/project-message-view/tool-cards/SecretRequestForm';
import { useIsMobile } from '../../hooks/useIsMobile';
import { InChatScene } from './InChatScene';
import {
  ANSWERED_THREAD,
  LIST_ITEMS,
  LONG_QUESTION,
  PROTO_NOW,
  QUESTION,
  QUESTION_THREAD,
  RESULT,
  RESULT_THREAD,
  REVIEW,
  REVIEW_THREAD,
  SECRET,
  SECRET_REQUEST,
  SECRET_THREAD,
  type ThreadEntry,
} from './mock-data';
import { AskTurn, MessageBox, Thread, ThreadRowHint } from './SideChat';

const noop = () => undefined;

/** Per-row conversation hint, keyed by item ref. */
const ROW_HINTS: Record<string, ReactNode> = {
  [QUESTION.ref]: (
    <ThreadRowHint unread tone="active" text="Agent: They keep their count… I’d go per project." />
  ),
  [SECRET.ref]: <ThreadRowHint unread tone="active" text="Agent: They live per project, not…" />,
  [REVIEW.ref]: <ThreadRowHint text="You asked · agent is looking" />,
  [RESULT.ref]: <ThreadRowHint text="2 follow-ups · 1 working, 1 queued" />,
};

function ListPane({ selectedRef }: { selectedRef: string | null }) {
  const rows = buildRows(LIST_ITEMS);
  return (
    <ul className="m-0 flex flex-col gap-1 p-2" aria-label="Items">
      {rows.map((row) => {
        const ref = row.type === 'item' ? row.item.ref : row.items[0]?.ref;
        return (
          <InboxRow
            key={row.key}
            row={row}
            selectedRef={selectedRef}
            showProject={false}
            now={PROTO_NOW}
            onOpen={noop}
          >
            {ref ? ROW_HINTS[ref] : null}
          </InboxRow>
        );
      })}
    </ul>
  );
}

function ItemTopBar() {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--sam-hairline)] px-1 py-1">
      <IconButton
        label="Back to inbox"
        icon={<ArrowLeft size={20} />}
        showTooltip={false}
        className="md:hidden"
      />
      <span className="flex flex-1 items-center justify-center md:justify-start">
        <IconButton label="Previous item" icon={<ChevronLeft size={20} />} showTooltip={false} />
        <span className="font-mono text-xs text-fg-muted">2/7</span>
        <IconButton label="Next item" icon={<ChevronRight size={20} />} showTooltip={false} />
      </span>
      <IconButton label="Archive: close it" icon={<Archive size={18} />} showTooltip={false} />
      <IconButton label="Open chat" icon={<MessageSquare size={18} />} showTooltip={false} />
    </div>
  );
}

/** Inline answer controls, sized for a message rather than a pinned bar. */
function OptionOffers({ options }: { options: string[] }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {options.map((option) => (
        <Button key={option} variant="raised" size="sm">
          {option}
        </Button>
      ))}
    </div>
  );
}

function AckOffer({ label }: { label: string }) {
  return (
    <Button variant="raised" size="sm">
      {label}
    </Button>
  );
}

/** The real secure field from the chat's secret card, inside the message. */
function SecretOffer() {
  return (
    <div className="sam-well rounded-xl px-3 py-3">
      <SecretRequestForm
        projectId={SECRET_REQUEST.projectId}
        request={SECRET_REQUEST}
        existing={null}
        onResolved={noop}
      />
    </div>
  );
}

/** One item as a conversation: the ask, the thread, and the message box pinned below. */
function ItemConversation({
  item,
  thread = [],
  offers,
  pending,
  box,
}: {
  item: InboxItem;
  thread?: ThreadEntry[];
  /** The item's answer controls; drawn on the ask, or on the latest agent turn that offers them. */
  offers?: ReactNode;
  pending?: string;
  box?: ReactNode;
}) {
  // Scrolled into the conversation: the ask stays visible as one sticky line.
  const [scrolled, setScrolled] = useState(false);
  const offerMovedDown = thread.some((entry) => entry.kind === 'agent' && entry.offers);
  return (
    <>
      <ItemTopBar />
      <div
        className="relative min-h-0 flex-1 overflow-y-auto"
        data-item-scroll
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 160)}
      >
        {scrolled && (
          <div className="sticky top-0 z-10 border-b border-[var(--sam-hairline)] bg-[var(--sam-separator)] px-4 py-2">
            <p className="m-0 mx-auto line-clamp-2 max-w-[680px] text-[13px] leading-snug font-medium break-words text-fg-primary">
              {item.title}
            </p>
          </div>
        )}
        <div className="mx-auto flex w-full max-w-[680px] min-w-0 flex-col gap-5 px-4 py-4">
          <AskTurn item={item} offers={offerMovedDown ? undefined : offers} />
          <Thread entries={thread} offers={offers} pending={pending} />
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--sam-hairline)] px-4 py-3">
        <div className="mx-auto w-full max-w-[680px] min-w-0">{box ?? <MessageBox />}</div>
      </div>
    </>
  );
}

const SCENES = {
  fresh: () => (
    <ItemConversation
      item={LONG_QUESTION}
      offers={<OptionOffers options={['Recreate it', 'Keep and re-grant']} />}
    />
  ),
  question: () => (
    <ItemConversation
      item={QUESTION}
      thread={QUESTION_THREAD}
      offers={<OptionOffers options={['Per node', 'Per project']} />}
    />
  ),
  answered: () => (
    <ItemConversation
      item={{ ...QUESTION, status: 'answered', agentState: 'working' }}
      thread={ANSWERED_THREAD}
      box={<MessageBox placeholder="Anything else about this?" />}
    />
  ),
  secret: () => <ItemConversation item={SECRET} thread={SECRET_THREAD} offers={<SecretOffer />} />,
  'secret-guard': () => (
    <ItemConversation
      item={SECRET}
      thread={SECRET_THREAD}
      offers={<SecretOffer />}
      box={<MessageBox guard />}
    />
  ),
  thinking: () => (
    <ItemConversation
      item={REVIEW}
      thread={REVIEW_THREAD}
      offers={<AckOffer label="Looks good" />}
      pending="Opening the Insights page with an empty project…"
    />
  ),
  followup: () => (
    <ItemConversation
      item={RESULT}
      thread={RESULT_THREAD}
      offers={<AckOffer label="Got it" />}
      box={<MessageBox placeholder="Ask, or add more work…" />}
    />
  ),
} satisfies Record<string, () => ReactNode>;

type ItemScene = keyof typeof SCENES;

const SCENE_SELECTED: Record<ItemScene, string> = {
  fresh: LONG_QUESTION.ref,
  question: QUESTION.ref,
  answered: QUESTION.ref,
  secret: SECRET.ref,
  'secret-guard': SECRET.ref,
  thinking: REVIEW.ref,
  followup: RESULT.ref,
};

function isItemScene(scene: string): scene is ItemScene {
  return scene in SCENES;
}

function PageHeader() {
  return (
    <Pane
      as="header"
      variant="slab"
      className="relative z-20 flex shrink-0 flex-col gap-3 px-3 py-3 md:px-5 md:py-4"
    >
      <div className="hidden md:block">
        <h1 className="m-0 text-2xl font-bold text-fg-primary">Inbox</h1>
        <p className="m-0 mt-0.5 text-sm text-fg-muted">What your agents need from you in SAM.</p>
      </div>
      <InboxFilterBar
        value="needs_you"
        onChange={noop}
        counts={{ needs_you: 7, blocking: 3, updates: 3 }}
      />
    </Pane>
  );
}

function MobileAppBar() {
  return (
    <Pane as="header" variant="slab" className="flex shrink-0 items-center gap-2 px-3 py-2">
      <InboxIcon size={18} aria-hidden="true" className="text-fg-muted" />
      <span className="text-[15px] font-semibold text-fg-primary">Inbox</span>
    </Pane>
  );
}

export function InboxThreadPrototype() {
  const [params] = useSearchParams();
  const scene = params.get('scene') ?? 'list';
  const isMobile = useIsMobile();

  let content: ReactNode;
  if (scene === 'in-chat') {
    content = <InChatScene />;
  } else if (isMobile) {
    content = isItemScene(scene) ? (
      <Pane className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Inbox item">
        {SCENES[scene]()}
      </Pane>
    ) : (
      <>
        <MobileAppBar />
        <PageHeader />
        <Pane
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          aria-label="Inbox list"
        >
          <ListPane selectedRef={null} />
        </Pane>
      </>
    );
  } else {
    const itemScene: ItemScene = isItemScene(scene) ? scene : 'question';
    content = (
      <>
        <PageHeader />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
          <Pane
            className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto"
            aria-label="Inbox list"
          >
            <ListPane selectedRef={SCENE_SELECTED[itemScene]} />
          </Pane>
          <Pane className="flex min-h-0 min-w-0 flex-col" aria-label="Inbox item">
            {SCENES[itemScene]()}
          </Pane>
        </div>
      </>
    );
  }

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <div
        className="sam-void flex h-screen min-w-0 flex-col gap-[var(--sam-space-gutter)] p-[var(--sam-shell-frame)]"
        data-testid="inbox-thread-prototype"
      >
        {content}
      </div>
    </div>
  );
}
