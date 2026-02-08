import React, { useRef, useState, useEffect } from 'react';
import { TabItem } from './TabItem';
import { TabOverflowMenu } from './TabOverflowMenu';
import type { TabBarProps } from '../types/multi-terminal';

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
  className = '',
}) => {
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);

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

  // Sort sessions by order
  const sortedSessions = [...sessions].sort((a, b) => a.order - b.order);

  return (
    <div className={`terminal-tab-bar ${className}`}>
      {showLeftScroll && (
        <button
          className="terminal-tab-scroll-left visible"
          onClick={() => handleScroll('left')}
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}

      <div className="terminal-tabs-container" ref={tabsContainerRef}>
        {sortedSessions.map((session) => (
          <TabItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onActivate={onTabActivate}
            onClose={onTabClose}
            onRename={onTabRename}
          />
        ))}
      </div>

      {showRightScroll && (
        <button
          className="terminal-tab-scroll-right visible"
          onClick={() => handleScroll('right')}
          aria-label="Scroll tabs right"
        >
          ›
        </button>
      )}

      {canCreateNewTab && (
        <button
          className="terminal-new-tab-button"
          onClick={onNewTab}
          aria-label="Create new terminal"
          title="New Terminal (Ctrl+Shift+T)"
        >
          +
        </button>
      )}

      {sessions.length > 5 && (
        <div className="terminal-tab-overflow-menu">
          <button
            className="terminal-tab-overflow-button"
            onClick={() => setShowOverflowMenu(!showOverflowMenu)}
            aria-label="Show all terminals"
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