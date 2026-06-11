import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { useScrollLock } from '../../hooks/useScrollLock';
import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { isStaleSession } from '../../lib/chat-session-utils';
import { stripMarkdown } from '../../lib/text-utils';
import { SessionList } from './SessionList';
import type { TaskInfo } from './useTaskGroups';

export function MobileSessionDrawer({
  sessions,
  selectedSessionId,
  onSelect,
  onFork,
  onNewChat,
  onClose,
  realtimeDegraded = false,
  isRefreshing = false,
  onRefresh,
  taskInfoMap = new Map(),
  onShowHierarchy,
}: {
  sessions: ChatSessionListItem[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onFork: (session: ChatSessionResponse) => void;
  onNewChat: () => void;
  onClose: () => void;
  realtimeDegraded?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  taskInfoMap?: Map<string, TaskInfo>;
  onShowHierarchy: (taskId: string) => void;
}) {
  const [mobileSearch, setMobileSearch] = useState('');
  const [mobileShowStale, setMobileShowStale] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(onClose, 250);
  }, [isClosing, onClose]);

  const { recent, stale } = useMemo(() => {
    const r: ChatSessionListItem[] = [];
    const s: ChatSessionListItem[] = [];
    for (const sess of sessions) {
      if (isStaleSession(sess)) s.push(sess);
      else r.push(sess);
    }
    return { recent: r, stale: s };
  }, [sessions]);

  const filteredR = useMemo(() => {
    if (!mobileSearch.trim()) return recent;
    const q = mobileSearch.toLowerCase();
    return recent.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [recent, mobileSearch]);

  const filteredS = useMemo(() => {
    if (!mobileSearch.trim()) return stale;
    const q = mobileSearch.toLowerCase();
    return stale.filter(
      (s) => (s.topic && stripMarkdown(s.topic).toLowerCase().includes(q)) || s.id.includes(q),
    );
  }, [stale, mobileSearch]);

  const showOlder = mobileShowStale || !!mobileSearch.trim();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // Prevent body scroll — always active while this drawer is mounted
  useScrollLock(true);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={handleClose}
        className="sam-glass-drawer-backdrop fixed inset-0 glass-backdrop-dim border-0 z-drawer-backdrop"
        data-state={isClosing ? 'closing' : 'open'}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat sessions"
        className="sam-glass-drawer-panel glass-panel-container fixed top-0 right-0 bottom-0 glass-modal border-r-0 rounded-l-[20px] rounded-r-none z-drawer flex flex-col overflow-hidden before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(34,197,94,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        data-state={isClosing ? 'closing' : 'open'}
        style={{
          width: '85vw',
          maxWidth: 320,
        }}
      >
        {/* Drawer header */}
        <div className="shrink-0 p-3 border-b border-border-default flex items-center gap-2">
          <span className="text-sm font-semibold text-fg-primary flex-1">Chats</span>
          {realtimeDegraded && onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              title="Realtime updates paused. Tap to refresh."
              aria-label="Realtime updates paused. Tap to refresh session list."
              className="flex items-center gap-1 bg-transparent border-none cursor-pointer text-xs px-1.5 py-0.5 rounded-sm"
              style={{ color: 'var(--sam-color-warning, #f59e0b)' }}
            >
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: 'var(--sam-color-warning, #f59e0b)' }}
              />
              <span>Refresh</span>
            </button>
          )}
          <button
            type="button"
            onClick={onNewChat}
            className="bg-transparent border border-border-default rounded-sm px-2 py-0.5 cursor-pointer text-fg-primary text-xs font-medium"
          >
            + New
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-2 py-1.5 border-b border-border-default">
          <div className="relative flex items-center">
            <Search size={13} className="absolute left-2 text-fg-muted pointer-events-none" />
            <input
              type="text"
              value={mobileSearch}
              onChange={(e) => setMobileSearch(e.target.value)}
              placeholder="Search chats..."
              className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-border-default bg-transparent text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent-primary"
            />
            {mobileSearch && (
              <button
                type="button"
                onClick={() => setMobileSearch('')}
                className="absolute right-1.5 p-0.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Subtle refresh indicator */}
        {isRefreshing && (
          <div className="h-0.5 bg-accent animate-pulse" role="status" aria-label="Refreshing sessions" />
        )}

        {/* Session list */}
        <nav aria-label="Chat sessions" className="flex-1 overflow-y-auto min-h-0">
          <SessionList
            sessions={filteredR}
            selectedSessionId={selectedSessionId}
            onSelect={onSelect}
            onFork={onFork}
            taskInfoMap={taskInfoMap}
            onShowHierarchy={onShowHierarchy}
          />
          {filteredS.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setMobileShowStale(!showOlder)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-fg-muted bg-transparent border-none border-b border-border-default cursor-pointer hover:bg-surface-hover transition-colors"
              >
                {showOlder ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Older ({filteredS.length})</span>
              </button>
              {showOlder && (
                <SessionList
                  sessions={filteredS}
                  selectedSessionId={selectedSessionId}
                  onSelect={onSelect}
                  onFork={onFork}
                  taskInfoMap={taskInfoMap}
                  onShowHierarchy={onShowHierarchy}
                />
              )}
            </>
          )}
        </nav>
      </div>
    </>,
    document.body,
  );
}
