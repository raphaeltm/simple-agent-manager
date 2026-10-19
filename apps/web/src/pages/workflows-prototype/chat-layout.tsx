/**
 * PROTOTYPE ONLY — project chat assembled from REAL production components:
 * SessionItem rows, SessionHeader, AcpConversationItemView (fed through the
 * real chatMessagesToConversationItems + groupToolCallItems), SessionToolRail,
 * CompletionDock and FollowUpInput. Only the page shell (which needs live
 * session state) and the mobile drawer frame (whose list can't show step
 * backlinks) are copied markup.
 */
import { Clock, List, Search, Settings, Workflow, X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import { CompletionDock } from '../../components/project-message-view/CompletionDock';
import { FollowUpInput } from '../../components/project-message-view/FollowUpInput';
import { useFloatingHeaderHeight } from '../../components/project-message-view/MessageListScaffold';
import { buildSessionToolActions } from '../../components/project-message-view/session-tool-actions';
import { SessionHeader } from '../../components/project-message-view/SessionHeader';
import { SessionToolRail } from '../../components/project-message-view/SessionToolRail';
import { groupToolCallItems } from '../../components/project-message-view/tool-call-groups';
import {
  chatMessagesToConversationItems,
  type SessionState,
} from '../../components/project-message-view/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { ChatMessageResponse, ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { SessionItem } from '../project-chat/SessionItem';
import { PROJECT } from './mock-world';
import { type IaOption, ProtoShell } from './shell';

export function WorkflowStepBadge() {
  const color = 'var(--sam-color-accent-primary)';
  return (
    <span
      title="Workflow step"
      aria-label="Workflow step"
      className="inline-flex items-center justify-center shrink-0 border"
      style={{
        width: 22,
        height: 22,
        borderRadius: 4,
        borderColor: color,
        color,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      <Workflow size={11} />
    </span>
  );
}

/** Real SessionItem rows inside the SessionTreeItem wrapper, plus optional custom rows. */
export function SessionRows({
  sessions,
  selectedId,
  onSelect,
  lineage = {},
  before,
}: {
  sessions: ChatSessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lineage?: Record<string, string>;
  before?: ReactNode;
}) {
  return (
    <>
      {before}
      {sessions.map((s) => {
        const isSelected = s.id === selectedId;
        return (
          <div
            key={s.id}
            style={{
              background: isSelected ? 'var(--sam-color-bg-inset, #0d1816)' : 'transparent',
              borderBottom: '1px solid var(--sam-color-border-default, #29423b)',
            }}
            className={
              isSelected
                ? 'transition-colors'
                : 'transition-colors hover:bg-[var(--sam-color-bg-surface-hover)]'
            }
          >
            <SessionItem
              session={s as ChatSessionResponse}
              isSelected={isSelected}
              onSelect={onSelect}
              badge={lineage[s.id] ? <WorkflowStepBadge /> : null}
              lineageText={lineage[s.id]}
              showOwnership={false}
            />
          </div>
        );
      })}
    </>
  );
}

export function SessionSidebar({
  children,
  filters,
}: {
  children: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <aside
      className="relative z-20 shrink-0 overflow-hidden glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col"
      style={{ width: 288 }}
    >
      <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(34,197,94,0.08)] flex items-center gap-2">
        <span className="text-sm font-semibold text-fg-primary truncate flex-1">
          {PROJECT.name}
        </span>
        <span className="shrink-0 p-1 text-fg-muted" title="Automation triggers">
          <Clock size={15} />
        </span>
        <span className="shrink-0 p-1 text-fg-muted" title="Project settings">
          <Settings size={15} />
        </span>
      </div>
      <div className="shrink-0 p-2 border-b border-[rgba(34,197,94,0.08)]">
        <button
          type="button"
          className="w-full py-1.5 px-3 rounded-md border border-[rgba(34,197,94,0.15)] bg-transparent cursor-pointer text-fg-primary text-xs font-medium"
        >
          + New Chat
        </button>
      </div>
      <div className="shrink-0 px-2 py-1.5 border-b border-[rgba(34,197,94,0.08)] space-y-1.5">
        <div className="relative flex items-center">
          <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search chats..."
            className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-[rgba(34,197,94,0.1)] bg-[var(--sam-form-bg)] text-fg-primary placeholder:text-fg-muted"
          />
        </div>
        {filters}
      </div>
      <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
        {children}
      </nav>
    </aside>
  );
}

export function MobileChatsDrawer({
  onClose,
  children,
  filters,
}: {
  onClose: () => void;
  children: ReactNode;
  filters?: ReactNode;
}) {
  return createPortal(
    <>
      <div
        role="presentation"
        onClick={onClose}
        className="fixed inset-0 glass-backdrop-dim border-0 z-drawer-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        className="glass-panel-container fixed top-0 right-0 bottom-0 glass-modal border-r-0 rounded-l-[20px] rounded-r-none z-drawer flex flex-col overflow-hidden"
        style={{ width: '85vw', maxWidth: 320 }}
      >
        <div className="shrink-0 p-3 border-b border-border-default flex items-center gap-2">
          <span className="text-sm font-semibold text-fg-primary flex-1">Chats</span>
          <button
            type="button"
            className="bg-transparent border border-border-default rounded-sm px-2 py-0.5 text-fg-primary text-xs font-medium"
          >
            + New
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 bg-transparent border-none text-fg-muted"
          >
            <X size={14} />
          </button>
        </div>
        {filters && (
          <div className="shrink-0 px-2 py-1.5 border-b border-border-default">{filters}</div>
        )}
        <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
          {children}
        </nav>
      </div>
    </>,
    document.body
  );
}

export type TranscriptEntry = ChatMessageResponse | { custom: string; node: ReactNode };

/** Real conversation rendering, with custom nodes (e.g. the run card) in sequence. */
export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const blocks = useMemo(() => {
    const out: { key: string; node: ReactNode }[] = [];
    let pending: ChatMessageResponse[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const items = groupToolCallItems(chatMessagesToConversationItems(pending));
      for (const item of items) {
        out.push({
          key: item.id,
          node: <AcpConversationItemView item={item} projectId={PROJECT.id} />,
        });
      }
      pending = [];
    };
    for (const e of entries) {
      if ('custom' in e) {
        flush();
        out.push({ key: e.custom, node: e.node });
      } else {
        pending.push(e);
      }
    }
    flush();
    return out;
  }, [entries]);

  return (
    <div role="log" aria-label="Conversation" className="flex flex-col">
      {blocks.map((b) => (
        <div key={b.key} className="sam-message-entry px-4 pb-3">
          {b.node}
        </div>
      ))}
    </div>
  );
}

export function ChatPane({
  session,
  sessionState,
  lineageText,
  banner,
  children,
  placeholder,
  working = false,
}: {
  session: ChatSessionListItem;
  sessionState: SessionState;
  lineageText?: string;
  banner?: ReactNode;
  children: ReactNode;
  placeholder: string;
  working?: boolean;
}) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'icons' | 'labels' | 'hidden'>('icons');
  const [draft, setDraft] = useState('');
  const [headerRef, headerHeight] = useFloatingHeaderHeight();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Like the real list (Virtuoso alignToBottom), open at the latest message.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [children]);
  const sess = session as ChatSessionResponse;
  const actions = useMemo(
    () =>
      buildSessionToolActions({
        session: sess,
        sessionState,
        taskEmbed: sess.task ?? null,
        reportEnabled: false,
        unresolvedCommentCount: 0,
        hasFilesHandler: true,
        hasGitHandler: true,
        hasTimelineHandler: true,
        hasResourcesHandler: true,
        hasEventsHandler: true,
        hasCommentsHandler: true,
        hasRetryHandler: true,
        hasForkHandler: true,
      }),
    [sess, sessionState]
  );

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0 flex flex-col">
          <div ref={headerRef} className="absolute top-0 left-0 right-0 z-10">
            <SessionHeader
              projectId={PROJECT.id}
              session={sess}
              sessionState={sessionState}
              idleCountdownMs={null}
              taskEmbed={sess.task ?? null}
              workspace={null}
              node={null}
              detectedPorts={[]}
              lineageText={lineageText}
              expanded={expanded}
              onExpandedChange={setExpanded}
              flushRight
            />
          </div>
          <div
            ref={scrollRef}
            data-scroll-target
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
            style={{ paddingTop: headerHeight + 12 }}
          >
            {banner && <div className="px-4 pb-3">{banner}</div>}
            {children}
          </div>
        </div>
        <SessionToolRail
          actions={actions}
          mode={mode}
          onModeChange={setMode}
          onSelect={() => undefined}
          isMobile={isMobile}
        />
      </div>
      <CompletionDock
        working={working}
        centerAction={working ? 'interrupt' : 'sleep'}
        hasPlan={false}
        onInterrupt={() => undefined}
        onSleep={() => undefined}
        onArchive={() => undefined}
        onOpenPlan={() => undefined}
      />
      <FollowUpInput
        value={draft}
        onChange={setDraft}
        onSend={() => setDraft('')}
        sending={false}
        placeholder={placeholder}
        transcribeApiUrl=""
      />
    </div>
  );
}

/** Desktop: nav + session sidebar + chat. Mobile: top bar + drawer. */
export function ChatLayout({
  option,
  label,
  rows,
  filters,
  children,
  stripExtra,
}: {
  option: IaOption;
  label: string;
  rows: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
  stripExtra?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  return (
    <ProtoShell option={option} active="chat" label={label} stripExtra={stripExtra}>
      <div className="flex-1 min-h-0 flex" data-testid="chat-layout">
        {!isMobile && <SessionSidebar filters={filters}>{rows}</SessionSidebar>}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {isMobile && (
            <div className="relative z-20 shrink-0 flex items-center gap-2 px-3 py-2 glass-chrome border-x-0 border-t-0">
              <span className="shrink-0 p-1.5 text-fg-muted">
                <Settings size={16} />
              </span>
              <span className="text-sm font-semibold text-fg-primary truncate flex-1">
                {PROJECT.name}
              </span>
              <button
                type="button"
                onClick={() => setDrawer(true)}
                aria-label="Open chat list"
                className="p-1.5 bg-transparent border-none cursor-pointer text-fg-muted"
              >
                <List size={18} />
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
      {isMobile && drawer && (
        <MobileChatsDrawer onClose={() => setDrawer(false)} filters={filters}>
          {rows}
        </MobileChatsDrawer>
      )}
    </ProtoShell>
  );
}
