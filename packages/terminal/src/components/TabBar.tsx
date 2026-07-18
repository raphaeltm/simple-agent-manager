import React, { useCallback, useEffect,useRef, useState } from 'react';

import { applyHoverIn, applyHoverOut, chromeButtonBase, colors, dimensions, fonts } from '../terminal-tokens';
import type { TabBarProps } from '../types/multi-terminal';
import { TabItem } from './TabItem';
import { TabOverflowMenu } from './TabOverflowMenu';

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  backgroundColor: colors.bgChrome,
  borderBottom: `1px solid ${colors.border}`,
  height: dimensions.tabBarHeight,
  flexShrink: 0,
  position: 'relative',
  userSelect: 'none',
};

const scrollBtnStyle: React.CSSProperties = {
  ...chromeButtonBase,
  width: dimensions.scrollBtnWidth,
  fontSize: 16,
};

const tabsContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  overflowX: 'auto',
  flex: 1,
  scrollBehavior: 'smooth',
  /* Hide scrollbar */
  scrollbarWidth: 'none',
  msOverflowStyle: 'none',
};

const newTabBtnStyle: React.CSSProperties = {
  ...chromeButtonBase,
  width: dimensions.newTabBtnWidth,
  borderLeft: `1px solid ${colors.border}`,
  fontSize: 18,
  fontWeight: 300,
  transition: 'color 0.15s, background-color 0.15s',
};

const overflowBtnStyle: React.CSSProperties = {
  ...chromeButtonBase,
  width: dimensions.overflowBtnWidth,
  borderLeft: `1px solid ${colors.border}`,
  fontSize: 16,
  fontFamily: fonts.ui,
  position: 'relative',
};

/**
 * Terminal tab bar component
 * Manages tab display, scrolling, and overflow
 */
export const TabBar: React.FC<TabBarProps> = ({
  sessions,
  activeSessionId,
  onTabActivate,
  onTabClose,
  onTabRename,
  onNewTab,
  maxTabs,
}) => {
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const hadTabFocusRef = useRef(false);
  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(activeSessionId);

  // Check if scrolling is needed
  useEffect(() => {
    const checkScroll = () => {
      const container = tabsContainerRef.current;
      if (!container) return;

      const { scrollLeft, scrollWidth, clientWidth } = container;
      setShowLeftScroll(scrollLeft > 0);
      setShowRightScroll(scrollLeft + clientWidth < scrollWidth);
    };

    checkScroll();
    const container = tabsContainerRef.current;
    container?.addEventListener('scroll', checkScroll);
    window.addEventListener('resize', checkScroll);

    return () => {
      container?.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [sessions]);

  // Scroll to active tab when it changes
  useEffect(() => {
    if (activeSessionId && tabsContainerRef.current) {
      const activeTab = tabsContainerRef.current.querySelector(
        `[data-session-id="${activeSessionId}"]`
      ) as HTMLElement;
      if (activeTab && activeTab.scrollIntoView) {
        activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [activeSessionId]);

  const focusTab = useCallback((sessionId: string) => {
    setFocusedSessionId(sessionId);
    requestAnimationFrame(() => {
      const tab = tabsContainerRef.current?.querySelector(
        `[data-session-id="${sessionId}"]`
      ) as HTMLElement | null;
      tab?.focus();
    });
  }, []);

  const sortedSessions = [...sessions].sort((a, b) => a.order - b.order);
  const rovingSessionId = sortedSessions.some((session) => session.id === focusedSessionId)
    ? focusedSessionId
    : activeSessionId && sortedSessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : sortedSessions[0]?.id ?? null;

  useEffect(() => {
    if (!activeSessionId) return;

    const activeTab = tabsContainerRef.current?.querySelector(
      `[data-session-id="${activeSessionId}"]`
    ) as HTMLElement | null;
    const focusWithinTabList = hadTabFocusRef.current
      || (tabsContainerRef.current?.contains(document.activeElement) ?? false);

    setFocusedSessionId(activeSessionId);

    if (focusWithinTabList) {
      activeTab?.focus();
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (rovingSessionId === focusedSessionId) return;
    setFocusedSessionId(rovingSessionId);
  }, [focusedSessionId, rovingSessionId]);

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, sessionId: string) => {
      const currentIndex = sortedSessions.findIndex((session) => session.id === sessionId);
      if (currentIndex === -1 || sortedSessions.length === 0) return;

      let nextIndex: number | null = null;
      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % sortedSessions.length;
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + sortedSessions.length) % sortedSessions.length;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = sortedSessions.length - 1;
      }

      if (nextIndex !== null) {
        e.preventDefault();
        const nextSession = sortedSessions[nextIndex];
        if (nextSession) focusTab(nextSession.id);
      }
    },
    [focusTab, sortedSessions]
  );

  const handleScroll = (direction: 'left' | 'right') => {
    const container = tabsContainerRef.current;
    if (!container) return;

    const scrollAmount = 200;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  const canCreateNewTab = sessions.length < maxTabs;

  return (
    <div style={tabBarStyle} role="tablist">
      {showLeftScroll && (
        <button
          style={scrollBtnStyle}
          onClick={() => handleScroll('left')}
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}

      <div
        style={tabsContainerStyle}
        ref={tabsContainerRef}
        onFocusCapture={(event) => {
          if ((event.target as HTMLElement).getAttribute('role') === 'tab') {
            hadTabFocusRef.current = true;
          }
        }}
        onBlurCapture={() => {
          requestAnimationFrame(() => {
            hadTabFocusRef.current = tabsContainerRef.current?.contains(document.activeElement) ?? false;
          });
        }}
      >
        {sortedSessions.map((session) => (
          <TabItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            tabIndex={session.id === rovingSessionId ? 0 : -1}
            onActivate={onTabActivate}
            onClose={onTabClose}
            onRename={onTabRename}
            onKeyDown={handleTabKeyDown}
          />
        ))}
      </div>

      {showRightScroll && (
        <button
          style={scrollBtnStyle}
          onClick={() => handleScroll('right')}
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      )}

      {canCreateNewTab && (
        <button
          style={newTabBtnStyle}
          onClick={onNewTab}
          aria-label="Create new terminal"
          title="New Terminal (Ctrl+Shift+T)"
          onMouseEnter={(e) => applyHoverIn(e.currentTarget)}
          onMouseLeave={(e) => applyHoverOut(e.currentTarget)}
        >
          +
        </button>
      )}

      {sessions.length > 5 && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            style={overflowBtnStyle}
            onClick={() => setShowOverflowMenu(!showOverflowMenu)}
            aria-label="Show all terminals"
            aria-expanded={showOverflowMenu}
            aria-haspopup="menu"
            title="All Terminals"
          >
            ⋮
          </button>
          {showOverflowMenu && (
            <TabOverflowMenu
              sessions={sortedSessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => {
                onTabActivate(id);
                setShowOverflowMenu(false);
              }}
              onClose={() => setShowOverflowMenu(false)}
            />
          )}
        </div>
      )}
    </div>
  );
};
