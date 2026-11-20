/**
 * PROTOTYPE ONLY: /prototype/inbox-thread?scene=<scene>. A side-chat on an inbox item: ask the
 * agent to clarify, add follow-ups, without leaving the inbox. Built from the real inbox
 * components (InboxRow, InboxItemBody, InboxFilterBar) with mock data. Never ship to production.
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
  MessagesSquare,
  Moon,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router';

import { buildRows } from '../../components/inbox/inbox-model';
import { InboxFilterBar } from '../../components/inbox/InboxFilterBar';
import { InboxItemBody } from '../../components/inbox/InboxItemView';
import { InboxRow } from '../../components/inbox/InboxRow';
import { useIsMobile } from '../../hooks/useIsMobile';
import { InChatScene } from './InChatScene';
import {
  LIST_ITEMS,
  LONG_QUESTION,
  PROTO_NOW,
  QUESTION,
  QUESTION_THREAD,
  RESULT,
  RESULT_THREAD,
  REVIEW,
  REVIEW_THREAD,
} from './mock-data';
import {
  type ComposerMode,
  DEFAULT_SUGGESTIONS,
  FollowupRoutePicker,
  SideChatComposer,
  ThreadRowHint,
  ThreadStarter,
  ThreadView,
} from './SideChat';

const noop = () => undefined;

/** Per-row side-chat hint, keyed by item ref. */
const ROW_HINTS: Record<string, ReactNode> = {
  [QUESTION.ref]: (
    <ThreadRowHint unread tone="active" text="Agent replied: They keep their current count…" />
  ),
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

function ItemTopBar({ extra }: { extra?: ReactNode }) {
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
        <span className="font-mono text-xs text-fg-muted">2/6</span>
        <IconButton label="Next item" icon={<ChevronRight size={20} />} showTooltip={false} />
      </span>
      {extra}
      <IconButton label="Archive: close it" icon={<Archive size={18} />} showTooltip={false} />
      <IconButton label="Open chat" icon={<MessageSquare size={18} />} showTooltip={false} />
    </div>
  );
}

function OptionAnswers({ options }: { options: string[] }) {
  return (
    <div className="flex min-w-0 gap-2">
      {options.map((option, i) => (
        <Button key={option} variant={i === 0 ? 'accent' : 'raised'} className="min-w-0 flex-1">
          {option}
        </Button>
      ))}
    </div>
  );
}

function AckAnswer({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <Button variant="accent" className="flex-1">
        {label}
      </Button>
    </div>
  );
}

/** The open item: top bar, scrolling body with the side-chat under the ask, pinned composer. */
function ItemPane({
  item,
  thread,
  composer,
  pending,
  topExtra,
}: {
  item: InboxItem;
  thread?: ReactNode;
  composer: ReactNode;
  pending?: string;
  topExtra?: ReactNode;
}) {
  // Scrolled into the conversation: the ask stays visible as one sticky line.
  const [scrolled, setScrolled] = useState(false);
  return (
    <>
      <ItemTopBar extra={topExtra} />
      <div
        className="relative min-h-0 flex-1 overflow-y-auto"
        data-item-scroll
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 160)}
      >
        {scrolled && (
          <div className="sticky top-0 z-10 border-b border-[var(--sam-hairline)] bg-[var(--sam-separator)] px-4 py-2">
            <p className="m-0 mx-auto line-clamp-2 max-w-[680px] text-[13px] leading-snug font-medium break-words text-fg-primary">
              <span className="text-fg-muted">
                {item.kind === 'question' ? 'Question' : 'About'}:{' '}
              </span>
              {item.title}
            </p>
          </div>
        )}
        <div className="mx-auto flex w-full max-w-[680px] min-w-0 flex-col gap-4 px-4 py-4">
          <InboxItemBody item={item} context={null} now={PROTO_NOW} stackPosition={null} />
          {thread}
          {pending && !thread && <ThreadView entries={[]} pending={pending} />}
        </div>
      </div>
      <div className="shrink-0 border-t border-[var(--sam-hairline)] px-4 py-3">
        <div className="mx-auto w-full max-w-[680px] min-w-0">{composer}</div>
      </div>
    </>
  );
}

type Scene = 'list' | 'fresh' | 'question' | 'thinking' | 'followup' | 'drawer' | 'in-chat';

/** An item nobody has talked about yet: the starter prompts sit under the ask. */
function freshScene() {
  return (
    <ItemPane
      item={LONG_QUESTION}
      thread={<ThreadStarter suggestions={DEFAULT_SUGGESTIONS} />}
      composer={
        <SideChatComposer
          answer={<OptionAnswers options={['Recreate it', 'Keep and re-grant']} />}
          mode="ask"
          modes={['ask', 'followup', 'answer']}
        />
      }
    />
  );
}

function sceneItem(scene: Scene) {
  switch (scene) {
    case 'fresh':
      return freshScene();
    case 'thinking':
      return thinkingScene();
    case 'followup':
      return followupScene();
    default:
      return questionScene();
  }
}

const SCENE_SELECTED: Partial<Record<Scene, string>> = {
  fresh: LONG_QUESTION.ref,
  thinking: REVIEW.ref,
  followup: RESULT.ref,
};

function questionScene(mode: ComposerMode = 'ask', draft = '') {
  return (
    <ItemPane
      item={QUESTION}
      thread={<ThreadView entries={QUESTION_THREAD} />}
      composer={
        <SideChatComposer
          answer={<OptionAnswers options={['Per node', 'Per project']} />}
          mode={mode}
          modes={['ask', 'followup', 'answer']}
          draft={draft}
        />
      }
    />
  );
}

function thinkingScene() {
  return (
    <ItemPane
      item={REVIEW}
      thread={
        <ThreadView
          entries={REVIEW_THREAD}
          pending="Opening the Insights page with an empty project…"
        />
      }
      composer={
        <SideChatComposer
          answer={<AckAnswer label="Looks good" />}
          mode="ask"
          modes={['ask', 'followup']}
        />
      }
    />
  );
}

function followupScene() {
  return (
    <ItemPane
      item={RESULT}
      thread={<ThreadView entries={RESULT_THREAD} />}
      composer={
        <SideChatComposer
          mode="followup"
          modes={['ask', 'followup']}
          draft="Also backport the fix to the release-2026.11 branch"
          notice={
            <p className="m-0 flex items-center gap-1.5 text-xs text-warning-fg">
              <Moon size={13} aria-hidden="true" /> This agent finished 2h ago. Sending wakes it in
              its chat.
            </p>
          }
          routePicker={<FollowupRoutePicker agentFinished />}
        />
      }
    />
  );
}

/** Variant B, desktop only: the side-chat as its own pane beside the item. */
function DrawerScene() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_380px] gap-[var(--sam-space-gutter)]">
      <Pane
        className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto"
        aria-label="Inbox list"
      >
        <ListPane selectedRef={QUESTION.ref} />
      </Pane>
      <Pane className="flex min-h-0 min-w-0 flex-col" aria-label="Inbox item">
        <ItemTopBar />
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[680px] min-w-0 flex-col gap-4 px-5 py-4">
            <InboxItemBody item={QUESTION} context={null} now={PROTO_NOW} stackPosition={null} />
          </div>
        </div>
        <div className="shrink-0 border-t border-[var(--sam-hairline)] px-5 py-3">
          <OptionAnswers options={['Per node', 'Per project']} />
        </div>
      </Pane>
      <Pane variant="quiet" className="flex min-h-0 min-w-0 flex-col" aria-label="Side-chat">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--sam-hairline)] py-1 pr-1 pl-4">
          <MessagesSquare size={16} aria-hidden="true" className="text-fg-muted" />
          <span className="flex-1 text-sm font-semibold text-fg-primary">
            Discuss with the agent
          </span>
          <IconButton label="Close side-chat" icon={<X size={18} />} showTooltip={false} />
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ThreadView entries={QUESTION_THREAD} heading={false} />
        </div>
        <div className="shrink-0 border-t border-[var(--sam-hairline)] px-4 py-3">
          <SideChatComposer mode="ask" modes={['ask', 'followup', 'answer']} showHint={false} />
        </div>
      </Pane>
    </div>
  );
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
        counts={{ needs_you: 6, blocking: 2, updates: 3 }}
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
  const scene = (params.get('scene') ?? 'list') as Scene;
  const isMobile = useIsMobile();

  let content: ReactNode;
  if (scene === 'in-chat') {
    content = <InChatScene />;
  } else if (scene === 'drawer' && !isMobile) {
    content = (
      <>
        <PageHeader />
        <DrawerScene />
      </>
    );
  } else if (isMobile) {
    const item = scene === 'list' ? null : sceneItem(scene);
    content = item ? (
      <Pane className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Inbox item">
        {item}
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
    const item = sceneItem(scene);
    const selected = SCENE_SELECTED[scene] ?? QUESTION.ref;
    content = (
      <>
        <PageHeader />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-[var(--sam-space-gutter)]">
          <Pane
            className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto"
            aria-label="Inbox list"
          >
            <ListPane selectedRef={selected} />
          </Pane>
          <Pane className="flex min-h-0 min-w-0 flex-col" aria-label="Inbox item">
            {item}
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
