/**
 * Chat Timeline Prototype
 *
 * Self-contained prototype using real glass styling and MessageBubble
 * from acp-client. No API calls, no auth — pure mock data.
 *
 * Features:
 * 1. Timeline panel (desktop: right drawer, mobile: bottom sheet)
 * 2. V2 density toggle (shows agent snippets before each human turn)
 * 3. Jump rail (minimap dots beside the chat)
 */
import { MessageBubble } from '@simple-agent-manager/acp-client';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  ExternalLink,
  GitPullRequest,
  Loader2,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  PanelRight,
  Power,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildTimeline,
  EMPTY_MESSAGES,
  EMPTY_NOTIFICATIONS,
  LONG_SESSION_MESSAGES,
  LONG_SESSION_NOTIFICATIONS,
  type MockMessage,
  type MockNotification,
  MOCK_SESSIONS,
  NOTIFICATION_STYLES,
  SINGLE_MESSAGE_MESSAGES,
  SINGLE_MESSAGE_NOTIFICATIONS,
  type TimelineEntry,
} from './mock-data';

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

type DatasetKey = 'long' | 'single' | 'empty';

const DATASETS: Record<DatasetKey, { label: string; messages: MockMessage[]; notifications: MockNotification[] }> = {
  long: { label: 'Long session (15+ turns)', messages: LONG_SESSION_MESSAGES, notifications: LONG_SESSION_NOTIFICATIONS },
  single: { label: 'Single message', messages: SINGLE_MESSAGE_MESSAGES, notifications: SINGLE_MESSAGE_NOTIFICATIONS },
  empty: { label: 'Empty state', messages: EMPTY_MESSAGES, notifications: EMPTY_NOTIFICATIONS },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    // Also truncate by character count for long single lines
    if (text.length > 120 * maxLines) return text.slice(0, 120 * maxLines) + '...';
    return text;
  }
  return lines.slice(0, maxLines).join('\n') + '...';
}

const NOTIF_ICONS: Record<MockNotification['type'], LucideIcon> = {
  task_complete: CheckCircle2,
  needs_input: MessageCircle,
  error: XCircle,
  progress: Loader2,
  pr_created: GitPullRequest,
  session_ended: Power,
};

// ---------------------------------------------------------------------------
// Notification type color for jump rail dots
// ---------------------------------------------------------------------------

function getNotifDotColor(type: MockNotification['type']): string {
  return NOTIFICATION_STYLES[type].color;
}

// ---------------------------------------------------------------------------
// Timeline Entry component
// ---------------------------------------------------------------------------

function TimelineEntryRow({
  entry,
  onJump,
}: {
  entry: TimelineEntry;
  onJump: (messageId: string) => void;
}) {
  if (entry.kind === 'notification') {
    const n = entry.notification;
    const style = NOTIFICATION_STYLES[n.type];
    const Icon = NOTIF_ICONS[n.type];
    return (
      <div
        className="flex items-start gap-2 px-3 py-2 rounded-md transition-colors hover:bg-[rgba(255,255,255,0.03)]"
        style={{ borderLeft: `3px solid ${style.color}` }}
      >
        <span className="shrink-0 mt-0.5" style={{ color: style.color }}>
          <Icon size={14} className={n.type === 'progress' ? 'motion-safe:animate-spin' : ''} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg-primary truncate">{n.title}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className="text-[10px] font-semibold uppercase px-1 py-0.5 rounded"
              style={{ color: style.color, backgroundColor: style.bgColor }}
            >
              {style.label}
            </span>
            <span className="text-[10px] text-fg-muted">{formatRelative(n.timestamp)}</span>
          </div>
          {n.actionUrl && (
            <a
              href={n.actionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 mt-1"
            >
              Open <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
    );
  }

  const msg = entry.message;
  const isLazy = msg.lazy;

  return (
    <button
      type="button"
      onClick={() => !isLazy && onJump(msg.id)}
      className={`w-full text-left flex items-start gap-2 px-3 py-2 rounded-md transition-colors border-none cursor-pointer ${
        isLazy
          ? 'opacity-40 cursor-default bg-transparent'
          : 'bg-transparent hover:bg-[rgba(34,197,94,0.04)]'
      }`}
      style={{ borderLeft: '3px solid var(--sam-color-accent-primary, #16a34a)' }}
      disabled={isLazy}
    >
      <span className="shrink-0 mt-0.5 text-fg-muted">
        <MessageSquare size={14} />
      </span>
      <div className="flex-1 min-w-0">
        {entry.agentSnippet && (
          <div
            className="text-[11px] text-fg-muted mb-1 px-2 py-1 rounded"
            style={{
              backgroundColor: 'rgba(34, 197, 94, 0.04)',
              borderLeft: '2px solid rgba(34, 197, 94, 0.15)',
            }}
          >
            <span className="text-[9px] uppercase font-semibold text-fg-muted opacity-60 block mb-0.5">Agent</span>
            {truncate(entry.agentSnippet, 2)}
          </div>
        )}
        <div className="text-xs text-fg-primary" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {isLazy ? <span className="italic">Message not loaded</span> : truncate(msg.text, 2)}
        </div>
        <span className="text-[10px] text-fg-muted mt-0.5 block">{formatRelative(msg.timestamp)}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Timeline Panel
// ---------------------------------------------------------------------------

function TimelinePanel({
  entries,
  showV2,
  onToggleV2,
  onJump,
  onClose,
  lazyBoundaryIndex,
}: {
  entries: TimelineEntry[];
  showV2: boolean;
  onToggleV2: () => void;
  onJump: (messageId: string) => void;
  onClose: () => void;
  lazyBoundaryIndex: number;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-[rgba(34,197,94,0.08)]">
        <span className="text-sm font-semibold text-fg-primary">Timeline</span>
        <div className="flex items-center gap-2">
          {/* V2 toggle */}
          <button
            type="button"
            onClick={onToggleV2}
            className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-all ${
              showV2
                ? 'border-[rgba(34,197,94,0.4)] bg-[rgba(34,197,94,0.08)] text-fg-primary'
                : 'border-[rgba(34,197,94,0.12)] bg-transparent text-fg-muted hover:border-[rgba(34,197,94,0.25)]'
            }`}
          >
            V2 Density
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close timeline"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-fg-muted">No messages yet</span>
          </div>
        ) : (
          <>
            {/* Lazy boundary affordance */}
            {lazyBoundaryIndex > 0 && (
              <>
                {entries.slice(0, lazyBoundaryIndex).map((e, i) => (
                  <TimelineEntryRow key={`lazy-${i}`} entry={e} onJump={onJump} />
                ))}
                <div className="flex items-center gap-2 px-3 py-2 my-1">
                  <div className="flex-1 h-px bg-[rgba(34,197,94,0.12)]" />
                  <button
                    type="button"
                    className="text-[10px] text-fg-muted hover:text-fg-primary bg-transparent border border-[rgba(34,197,94,0.12)] rounded-full px-2 py-0.5 cursor-pointer transition-colors"
                  >
                    Load older messages
                  </button>
                  <div className="flex-1 h-px bg-[rgba(34,197,94,0.12)]" />
                </div>
                {entries.slice(lazyBoundaryIndex).map((e, i) => (
                  <TimelineEntryRow key={`loaded-${i}`} entry={e} onJump={onJump} />
                ))}
              </>
            )}
            {lazyBoundaryIndex === 0 && entries.map((e, i) => (
              <TimelineEntryRow key={i} entry={e} onJump={onJump} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jump Rail (minimap)
// ---------------------------------------------------------------------------

function JumpRail({
  entries,
  onJump,
  vertical,
}: {
  entries: TimelineEntry[];
  onJump: (messageId: string) => void;
  vertical: boolean;
}) {
  if (entries.length === 0) return null;

  const dots = entries.map((e, i) => {
    if (e.kind === 'notification') {
      const color = getNotifDotColor(e.notification.type);
      return (
        <span
          key={`notif-${i}`}
          className="block rounded-full shrink-0"
          style={{
            width: 6, height: 6,
            backgroundColor: color,
            opacity: 0.8,
          }}
          title={e.notification.title}
        />
      );
    }
    const msg = e.message;
    return (
      <button
        key={msg.id}
        type="button"
        onClick={() => onJump(msg.id)}
        className="block rounded-full shrink-0 border-none cursor-pointer bg-transparent p-0 hover:scale-125 transition-transform"
        style={{
          width: 8, height: 8,
          backgroundColor: msg.lazy
            ? 'rgba(159, 183, 174, 0.3)'
            : 'var(--sam-color-accent-primary, #16a34a)',
        }}
        title={truncate(msg.text, 1)}
        disabled={msg.lazy}
      />
    );
  });

  if (vertical) {
    return (
      <div
        className="shrink-0 flex flex-col items-center gap-1.5 py-4 px-1.5"
        style={{
          borderRight: '1px solid rgba(34, 197, 94, 0.06)',
        }}
      >
        {dots}
      </div>
    );
  }

  // Horizontal (mobile) — below header
  return (
    <div
      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto"
      style={{
        borderBottom: '1px solid rgba(34, 197, 94, 0.06)',
      }}
    >
      {dots}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile Bottom Sheet
// ---------------------------------------------------------------------------

function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 glass-chrome rounded-t-2xl"
        style={{
          maxHeight: '70vh',
          boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.4)',
        }}
      >
        {/* Drag handle */}
        <div className="flex justify-center py-2">
          <div className="w-8 h-1 rounded-full bg-[rgba(159,183,174,0.3)]" />
        </div>
        <div style={{ height: 'calc(70vh - 20px)', overflow: 'hidden' }}>
          {children}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Session sidebar item (matches real SessionItem styling)
// ---------------------------------------------------------------------------

function MockSessionItem({
  session,
  isSelected,
  onSelect,
}: {
  session: typeof MOCK_SESSIONS[0];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const statusColors: Record<string, string> = {
    running: 'var(--sam-color-success, #22c55e)',
    completed: 'var(--sam-color-fg-muted, #9fb7ae)',
    failed: 'var(--sam-color-danger, #ef4444)',
    stopped: 'var(--sam-color-fg-muted, #9fb7ae)',
  };
  const StatusIcon = session.status === 'running' ? Loader2 : session.status === 'failed' ? XCircle : CheckCircle2;

  return (
    <div
      className={`block w-full text-left px-3 py-1.5 border-b border-[rgba(34,197,94,0.06)] transition-all duration-150 ${
        isSelected ? 'bg-[rgba(22,163,74,0.08)]' : 'hover:bg-[rgba(34,197,94,0.04)]'
      }`}
      style={{
        borderLeft: isSelected
          ? '3px solid var(--sam-color-accent-primary)'
          : '3px solid transparent',
        boxShadow: isSelected
          ? 'inset 3px 0 8px -3px rgba(34, 197, 94, 0.3)'
          : undefined,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="block w-full text-left bg-transparent border-none cursor-pointer p-0"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="shrink-0 flex items-center" style={{ color: statusColors[session.status] }}>
            <StatusIcon size={14} className={session.status === 'running' ? 'motion-safe:animate-spin' : ''} />
          </span>
          <span className={`overflow-hidden text-ellipsis whitespace-nowrap flex-1 text-sm ${
            isSelected ? 'font-semibold text-fg-primary' : 'font-medium text-fg-primary'
          }`}>
            {session.topic}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-fg-muted" style={{ fontSize: 10, paddingLeft: 20 }}>
          <span>{session.mode === 'task' ? 'Task' : 'Chat'}</span>
          <span className="ml-auto shrink-0">{formatRelative(session.updatedAt)}</span>
        </div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Prototype
// ---------------------------------------------------------------------------

export function ChatTimelinePrototype() {
  const [dataset, setDataset] = useState<DatasetKey>('long');
  const [showTimeline, setShowTimeline] = useState(false);
  const [showV2, setShowV2] = useState(false);
  const [showRail, setShowRail] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const { messages, notifications } = DATASETS[dataset];

  const timeline = useMemo(
    () => buildTimeline(messages, notifications, showV2),
    [messages, notifications, showV2],
  );

  // Find the index where lazy messages end
  const lazyBoundaryIndex = useMemo(() => {
    for (let i = 0; i < timeline.length; i++) {
      const e = timeline[i]!;
      if (e.kind === 'user_message' && !e.message.lazy) return i;
    }
    return 0;
  }, [timeline]);

  const handleJump = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(messageId);
      setTimeout(() => setHighlightId(null), 1500);
    }
    // Close bottom sheet on mobile after jump
    if (isMobile) setShowTimeline(false);
  }, [isMobile]);

  return (
    <div style={{ height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* ================================================================ */}
      {/* Layout matching ProjectChat: sidebar + main content              */}
      {/* ================================================================ */}
      <div className="flex flex-1 min-h-0">

        {/* Desktop sidebar */}
        {!isMobile && (
          <div className="relative z-20 w-72 shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col">
            {/* Sidebar header */}
            <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(34,197,94,0.08)] flex items-center gap-2">
              <span className="text-sm font-semibold text-fg-primary truncate flex-1">
                SAM Project
              </span>
            </div>

            {/* New chat button */}
            <div className="shrink-0 p-2 border-b border-[rgba(34,197,94,0.08)]">
              <button
                type="button"
                className="w-full py-1.5 px-3 rounded-md border border-[rgba(34,197,94,0.15)] bg-transparent cursor-pointer text-fg-primary text-xs font-medium hover:bg-[rgba(34,197,94,0.06)] hover:border-[rgba(34,197,94,0.25)] transition-all"
              >
                + New Chat
              </button>
            </div>

            {/* Session list */}
            <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
              {MOCK_SESSIONS.map((s) => (
                <MockSessionItem
                  key={s.id}
                  session={s}
                  isSelected={s.id === 'sess-active'}
                  onSelect={() => {}}
                />
              ))}
            </nav>
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">

          {/* Mobile header */}
          {isMobile && (
            <div className="relative z-20 shrink-0 flex items-center gap-2 px-3 py-2 glass-chrome border-x-0 border-t-0">
              <span className="text-sm font-semibold text-fg-primary truncate flex-1">
                SAM Project
              </span>
            </div>
          )}

          {/* Session header (floating glass bar) */}
          <div className="relative z-10">
            <div
              className="glass-chrome px-4 py-2 flex items-center gap-2"
              style={{
                boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
              }}
            >
              {/* Session title */}
              <span className="text-sm font-medium text-fg-primary truncate flex-1">
                Workspace CRUD API with auth and WebSocket logs
              </span>

              {/* Dataset switcher */}
              <select
                value={dataset}
                onChange={(e) => setDataset(e.target.value as DatasetKey)}
                className="text-[10px] bg-transparent border border-[rgba(34,197,94,0.12)] rounded px-1.5 py-0.5 text-fg-muted cursor-pointer focus:outline-none"
              >
                {Object.entries(DATASETS).map(([key, { label }]) => (
                  <option key={key} value={key} style={{ background: '#0a0f0d' }}>{label}</option>
                ))}
              </select>

              {/* Rail toggle */}
              <button
                type="button"
                onClick={() => setShowRail(!showRail)}
                className={`p-1.5 rounded-md border transition-all ${
                  showRail
                    ? 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.08)] text-fg-primary'
                    : 'border-transparent bg-transparent text-fg-muted hover:text-fg-primary'
                }`}
                title="Toggle jump rail"
              >
                <Circle size={14} />
              </button>

              {/* Timeline toggle */}
              <button
                type="button"
                onClick={() => setShowTimeline(!showTimeline)}
                className={`p-1.5 rounded-md border transition-all ${
                  showTimeline
                    ? 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.08)] text-fg-primary'
                    : 'border-transparent bg-transparent text-fg-muted hover:text-fg-primary'
                }`}
                title="Toggle timeline"
              >
                <PanelRight size={14} />
              </button>
            </div>
          </div>

          {/* Chat + Rail + Drawer area */}
          <div className="flex-1 flex min-h-0">

            {/* Jump rail (desktop: vertical left, mobile: hidden — use horizontal below header) */}
            {showRail && !isMobile && (
              <JumpRail entries={timeline} onJump={handleJump} vertical />
            )}

            {/* Jump rail (mobile: horizontal strip) */}
            {showRail && isMobile && (
              <div className="absolute z-10 left-0 right-0" style={{ top: isMobile ? 88 : 48 }}>
                <JumpRail entries={timeline} onJump={handleJump} vertical={false} />
              </div>
            )}

            {/* Chat messages */}
            <div
              ref={chatScrollRef}
              className="flex-1 overflow-y-auto min-h-0"
              style={{ paddingTop: showRail && isMobile ? 32 : 16, paddingBottom: 80 }}
            >
              <div className="max-w-3xl mx-auto px-4">
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-20">
                    <span className="text-base font-semibold text-fg-primary">
                      What do you want to build?
                    </span>
                    <span className="text-sm text-fg-muted text-center max-w-[400px]">
                      Describe the task and an agent will start working on it automatically.
                    </span>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      id={`msg-${msg.id}`}
                      className="transition-all duration-500"
                      style={{
                        boxShadow: highlightId === msg.id
                          ? '0 0 0 2px var(--sam-color-accent-primary, #16a34a), 0 0 20px rgba(34, 197, 94, 0.3)'
                          : 'none',
                        borderRadius: highlightId === msg.id ? 12 : 0,
                      }}
                    >
                      {msg.role === 'system' ? (
                        <div className="flex justify-start mb-4">
                          <div
                            className="max-w-[90%] min-w-0 rounded-lg px-4 py-2 border overflow-hidden"
                            style={{
                              backgroundColor: 'rgba(22, 163, 74, 0.06)',
                              borderColor: 'rgba(34, 197, 94, 0.1)',
                            }}
                          >
                            <div className="flex items-center gap-1.5 mb-2">
                              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--sam-color-fg-muted)' }}>
                                System
                              </span>
                            </div>
                            <pre className="text-xs whitespace-pre-wrap break-words m-0 font-mono leading-relaxed" style={{ color: 'var(--sam-color-fg-primary)' }}>
                              {msg.text}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        <MessageBubble
                          text={msg.text}
                          role={msg.role === 'user' ? 'user' : 'agent'}
                          bubbleClassName={msg.role === 'user' ? 'glass-msg-user' : 'glass-msg-assistant'}
                        />
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Desktop timeline drawer */}
            {showTimeline && !isMobile && (
              <div
                className="shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-r-0"
                style={{ width: 320 }}
              >
                <TimelinePanel
                  entries={timeline}
                  showV2={showV2}
                  onToggleV2={() => setShowV2(!showV2)}
                  onJump={handleJump}
                  onClose={() => setShowTimeline(false)}
                  lazyBoundaryIndex={lazyBoundaryIndex}
                />
              </div>
            )}
          </div>

          {/* Mock input bar */}
          <div className="shrink-0 border-t border-[rgba(34,197,94,0.08)] px-4 py-3">
            <div className="max-w-3xl mx-auto">
              <div
                className="flex items-center gap-2 rounded-lg border border-[rgba(34,197,94,0.12)] bg-[rgba(0,0,0,0.2)] px-3 py-2.5"
              >
                <span className="text-sm text-fg-muted flex-1">Send a follow-up message...</span>
                <ChevronUp size={16} className="text-fg-muted" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom sheet timeline */}
      {isMobile && (
        <BottomSheet open={showTimeline} onClose={() => setShowTimeline(false)}>
          <TimelinePanel
            entries={timeline}
            showV2={showV2}
            onToggleV2={() => setShowV2(!showV2)}
            onJump={handleJump}
            onClose={() => setShowTimeline(false)}
            lazyBoundaryIndex={lazyBoundaryIndex}
          />
        </BottomSheet>
      )}
    </div>
  );
}
