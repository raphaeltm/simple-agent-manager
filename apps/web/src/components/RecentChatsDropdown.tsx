import { Loader2, MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useRecentChats } from '../hooks/useRecentChats';
import {
  formatRelativeTime,
  getLastActivity,
  getSessionState,
  STATE_COLORS,
  STATE_LABELS,
} from '../lib/chat-session-utils';

export function RecentChatsDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const { chats, activeCount, loading, error, refresh } = useRecentChats(isOpen);

  // Position the panel relative to the trigger button
  useEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const isMobile = window.innerWidth < 640;
    if (isMobile) {
      setPanelStyle({ top: rect.bottom + 8 });
    } else {
      const panelWidth = 340;
      const clampedLeft = Math.min(rect.left, window.innerWidth - panelWidth - 8);
      setPanelStyle({ top: rect.bottom + 8, left: Math.max(8, clampedLeft) });
    }
  }, [isOpen]);

  // Close on click outside and Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleChatClick = useCallback(
    (projectId: string, sessionId: string) => {
      navigate(`/projects/${projectId}/chat/${sessionId}`);
      setIsOpen(false);
    },
    [navigate],
  );

  const handleViewAll = useCallback(() => {
    navigate('/chats');
    setIsOpen(false);
  }, [navigate]);

  return (
    <div className="relative">
      {/* Trigger Button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Recent chats${activeCount > 0 ? ` (${activeCount} active)` : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="relative flex items-center justify-center w-11 h-11 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary transition-colors"
      >
        <MessageSquare size={18} />
        {activeCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-fg-on-accent text-[10px] font-bold leading-none">
            {activeCount > 99 ? '99+' : activeCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel — portaled to body */}
      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Recent chats"
            style={panelStyle}
            className="fixed inset-x-4 sm:inset-x-auto sm:w-[340px] max-h-[calc(100vh-5rem)] sm:max-h-[480px] bg-surface border border-border-default rounded-lg shadow-lg flex flex-col z-[100] overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
              <h3 className="text-sm font-semibold text-fg-primary">Recent Chats</h3>
              {activeCount > 0 && (
                <span className="text-xs text-fg-muted">
                  {activeCount} active
                </span>
              )}
            </div>

            {/* Chat List */}
            <div className="flex-1 overflow-y-auto" aria-label="Recent chat sessions">
              {loading && chats.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-fg-muted">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-8 text-fg-muted text-sm">
                  <span className="mb-2">{error}</span>
                  <button
                    onClick={() => refresh()}
                    className="text-xs text-accent bg-transparent border-none cursor-pointer hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    Retry
                  </button>
                </div>
              ) : chats.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-fg-muted text-sm">
                  <MessageSquare size={24} className="mb-2 opacity-40" />
                  <span>No active chats</span>
                  <p className="text-xs mt-1 px-6 text-center">
                    Start a conversation in any project to see it here.
                  </p>
                </div>
              ) : (
                chats.map((chat) => {
                  const state = getSessionState(chat);
                  const dotColor = STATE_COLORS[state];
                  const stateLabel = STATE_LABELS[state];
                  const topic = chat.topic || 'Untitled Chat';
                  const lastActivity = getLastActivity(chat);

                  return (
                    <button
                      key={chat.id}
                      role="menuitem"
                      onClick={() => handleChatClick(chat.projectId, chat.id)}
                      aria-label={`${topic}, ${chat.projectName}, ${stateLabel}, ${formatRelativeTime(lastActivity)}`}
                      className="flex items-center gap-3 w-full px-4 py-2.5 min-h-[44px] bg-transparent border-none border-b border-border-default text-left cursor-pointer hover:bg-surface-hover transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      {/* State dot */}
                      <span
                        aria-hidden="true"
                        className="shrink-0 w-2 h-2 rounded-full"
                        style={{ backgroundColor: dotColor }}
                      />

                      {/* Topic + project */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-fg-primary m-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          {topic}
                        </p>
                        <p className="text-xs text-fg-muted m-0 mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
                          {chat.projectName}
                        </p>
                      </div>

                      {/* Relative time */}
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-xs text-fg-muted whitespace-nowrap"
                      >
                        {formatRelativeTime(lastActivity)}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer — View All link */}
            {chats.length > 0 && (
              <div className="border-t border-border-default">
                <button
                  onClick={handleViewAll}
                  className="w-full min-h-[44px] py-2.5 text-xs text-accent font-medium bg-transparent border-none cursor-pointer hover:bg-surface-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  View all chats
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
