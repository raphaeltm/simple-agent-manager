import { SearchField, SegmentedControl } from '@simple-agent-manager/ui';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { GlassSheet, GlassSheetHeader } from '../../components/shell/GlassSheet';
import { useScrollLock } from '../../hooks/useScrollLock';
import type { ChatSessionListItem } from '../../lib/api';
import { sessionScopeOptions } from './session-scope-options';
import { SessionSectionList } from './SessionSectionList';
import type { SessionScope } from './useProjectChatState';
import { useSessionSections } from './useSessionSections';
import type { TaskInfo } from './useTaskGroups';

/** A stable default, so the session filters don't recompute on every render. */
const EMPTY_TASK_INFO_MAP = new Map<string, TaskInfo>();

export function MobileSessionDrawer({
  sessions,
  selectedSessionId,
  onSelect,
  onNewChat,
  onClose,
  realtimeDegraded = false,
  isRefreshing = false,
  onRefresh,
  taskInfoMap = EMPTY_TASK_INFO_MAP,
  onShowHierarchy,
  sessionScope,
  onSessionScopeChange,
  showOwnership,
}: {
  sessions: ChatSessionListItem[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  realtimeDegraded?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  taskInfoMap?: Map<string, TaskInfo>;
  onShowHierarchy: (taskId: string) => void;
  sessionScope: SessionScope;
  onSessionScopeChange: (scope: SessionScope) => void;
  showOwnership: boolean;
}) {
  const [mobileSearch, setMobileSearch] = useState('');
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(onClose, 250);
  }, [isClosing, onClose]);

  // Same sections and search as the desktop list.
  const { sections, isSearching, openSections, toggleSection } = useSessionSections(
    sessions,
    taskInfoMap,
    mobileSearch
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // Prevent body scroll — always active while this drawer is mounted
  useScrollLock(true);

  return (
    <GlassSheet
      label="Chat sessions"
      edge="right"
      onBackdropClick={handleClose}
      closing={isClosing}
      widthClassName="w-[88vw] max-w-[360px]"
    >
      <GlassSheetHeader title="Chats" onClose={handleClose} closeLabel="Close chat list">
        {realtimeDegraded && onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title="Realtime updates paused. Tap to refresh."
            aria-label="Realtime updates paused. Tap to refresh session list."
            className="mt-1 flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border-none bg-transparent px-1 text-xs text-warning-fg"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--sam-color-warning)]"
            />
            <span>Refresh</span>
          </button>
        )}
      </GlassSheetHeader>

      {/* Search + new chat, then the ownership filter */}
      <div className="shrink-0 space-y-2.5 px-4 pb-3">
        <div className="flex items-center gap-2.5">
          <SearchField
            value={mobileSearch}
            onValueChange={setMobileSearch}
            placeholder="Search chats..."
            size="lg"
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={onNewChat}
            aria-label="New chat"
            title="New chat"
            className="inline-grid h-12 w-12 shrink-0 cursor-pointer place-items-center rounded-[14px] border-0 bg-[linear-gradient(180deg,var(--sam-accent-top),var(--sam-accent-bottom))] text-[var(--sam-on-accent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.32),var(--sam-shadow-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <Plus size={22} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
        {showOwnership && (
          <SegmentedControl
            label="Session ownership filter"
            value={sessionScope}
            onChange={onSessionScopeChange}
            options={sessionScopeOptions(sessions, sessionScope)}
            size="lg"
          />
        )}
      </div>

      {/* Subtle refresh indicator */}
      {isRefreshing && (
        <div
          className="mx-4 h-0.5 animate-pulse rounded-full bg-accent"
          role="status"
          aria-label="Refreshing sessions"
        />
      )}

      {/* Session list */}
      <nav aria-label="Chat sessions" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <SessionSectionList
          sections={sections}
          isSearching={isSearching}
          openSections={openSections}
          onToggleSection={toggleSection}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          taskInfoMap={taskInfoMap}
          onShowHierarchy={onShowHierarchy}
          showOwnership={showOwnership}
          size="lg"
        />
      </nav>
    </GlassSheet>
  );
}
