/**
 * PROTOTYPE ONLY: /prototype/inbox-thread?scene=<scene>. Replying to an inbox item works like
 * sending a message in the agent's chat, with a pointer to the item. Once you reply, the item
 * leaves your inbox until the agent responds on it or changes the ask. Built from the real
 * inbox and chat components with mock data. Never ship to production.
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

import { buildRows, type InboxView } from '../../components/inbox/inbox-model';
import { InboxFilterBar } from '../../components/inbox/InboxFilterBar';
import { InboxReceiptLine } from '../../components/inbox/InboxItemView';
import { InboxRow } from '../../components/inbox/InboxRow';
import { SecretRequestForm } from '../../components/project-message-view/tool-cards/SecretRequestForm';
import { useIsMobile } from '../../hooks/useIsMobile';
import { InChatScene } from './InChatScene';
import {
  LIST_ITEMS,
  PROTO_NOW,
  QUESTION,
  QUESTION_THREAD,
  RESULT,
  SECRET,
  SECRET_REQUEST,
  SECRET_THREAD,
  type ThreadEntry,
  WITH_AGENT_ITEMS,
} from './mock-data';
import { AskTurn, ItemComposer, Thread, ThreadRowHint } from './SideChat';

const noop = () => undefined;

type ListState = 'before' | 'sent' | 'back' | 'archived';

/** Row hints per list state, keyed by item ref. */
function rowHints(state: ListState): Record<string, ReactNode> {
  if (state === 'archived')
    return {
      [QUESTION.ref]: <ThreadRowHint text="You replied 2m ago · with the agent" />,
      [RESULT.ref]: <ThreadRowHint text="You replied 30m ago · agent is working on it" />,
    };
  if (state === 'back')
    return {
      [QUESTION.ref]: (
        <ThreadRowHint unread tone="active" text="Agent responded: They keep their count…" />
      ),
      [SECRET.ref]: (
        <ThreadRowHint unread tone="active" text="Agent responded: They live per project…" />
      ),
    };
  return {};
}

function listItems(state: ListState): InboxItem[] {
  if (state === 'archived') return WITH_AGENT_ITEMS;
  if (state === 'sent') return LIST_ITEMS.filter((item) => item.ref !== QUESTION.ref);
  if (state === 'back')
    // Back on top: the agent's response is the newest thing on the item.
    return [QUESTION, ...LIST_ITEMS.filter((item) => item.ref !== QUESTION.ref)];
  return LIST_ITEMS;
}

function ListPane({ state, selectedRef }: { state: ListState; selectedRef: string | null }) {
  const rows = buildRows(listItems(state));
  const hints = rowHints(state);
  return (
    <>
      {state === 'sent' && (
        <InboxReceiptLine
          receipt={{
            id: 1,
            tone: 'success',
            text: 'Sent to the agent’s chat. This comes back if it responds.',
            onUndo: noop,
          }}
        />
      )}
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
              {ref ? hints[ref] : null}
            </InboxRow>
          );
        })}
      </ul>
    </>
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

/** One open item: the ask, what happened on it since, and the chat composer pinned below. */
function ItemConversation({
  item,
  thread = [],
  offers,
  draft,
  attachmentNames,
}: {
  item: InboxItem;
  thread?: ThreadEntry[];
  offers?: ReactNode;
  draft?: string;
  attachmentNames?: string[];
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
          <Thread entries={thread} offers={offers} />
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--sam-hairline)]">
        <div className="mx-auto w-full max-w-[712px] min-w-0 px-1 py-1">
          <ItemComposer draft={draft} attachmentNames={attachmentNames} />
        </div>
      </div>
    </>
  );
}

const ITEM_SCENES = {
  open: () => (
    <ItemConversation
      item={QUESTION}
      offers={<OptionOffers options={['Per node', 'Per project']} />}
    />
  ),
  compose: () => (
    <ItemConversation
      item={QUESTION}
      offers={<OptionOffers options={['Per node', 'Per project']} />}
      draft="What happens to nodes that are already mid-retry if we switch to per project? Screenshot of the retry graph from last week attached."
      attachmentNames={['retry-graph-week-46.png']}
    />
  ),
  responded: () => (
    <ItemConversation
      item={QUESTION}
      thread={QUESTION_THREAD}
      offers={<OptionOffers options={['Per node', 'Per project']} />}
    />
  ),
  secret: () => <ItemConversation item={SECRET} thread={SECRET_THREAD} offers={<SecretOffer />} />,
} satisfies Record<string, () => ReactNode>;

type ItemScene = keyof typeof ITEM_SCENES;
const LIST_SCENES: Record<string, ListState> = {
  list: 'before',
  sent: 'sent',
  back: 'back',
  archived: 'archived',
};

function isItemScene(scene: string): scene is ItemScene {
  return scene in ITEM_SCENES;
}

function PageHeader({ view }: { view: InboxView }) {
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
        value={view}
        onChange={noop}
        counts={{ needs_you: view === 'archived' ? 6 : 7, blocking: 3, updates: 3 }}
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
  const listState = LIST_SCENES[scene] ?? 'before';
  const view: InboxView = listState === 'archived' ? 'archived' : 'needs_you';

  let content: ReactNode;
  if (scene === 'chat') {
    content = <InChatScene />;
  } else if (isMobile) {
    content = isItemScene(scene) ? (
      <Pane className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Inbox item">
        {ITEM_SCENES[scene]()}
      </Pane>
    ) : (
      <>
        <MobileAppBar />
        <PageHeader view={view} />
        <Pane
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          aria-label="Inbox list"
        >
          <ListPane state={listState} selectedRef={null} />
        </Pane>
      </>
    );
  } else {
    const itemScene: ItemScene = isItemScene(scene) ? scene : 'open';
    const selected = itemScene === 'secret' ? SECRET.ref : QUESTION.ref;
    const deskList: ListState =
      itemScene === 'responded' || itemScene === 'secret' ? 'back' : listState;
    content = (
      <>
        <PageHeader view={view} />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
          <Pane
            className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto"
            aria-label="Inbox list"
          >
            <ListPane state={deskList} selectedRef={selected} />
          </Pane>
          <Pane className="flex min-h-0 min-w-0 flex-col" aria-label="Inbox item">
            {ITEM_SCENES[itemScene]()}
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
