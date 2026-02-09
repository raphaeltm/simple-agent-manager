import React, { useRef, useState, useEffect } from 'react';
import { TabItem } from './TabItem';
import { TabOverflowMenu } from './TabOverflowMenu';
import type { TabBarProps } from '../types/multi-terminal';

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  backgroundColor: '#16171e',
  borderBottom: '1px solid #2a2d3a',
  height: 38,
  flexShrink: 0,
  position: 'relative',
  userSelect: 'none',
};

const scrollBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  background: 'none',
  border: 'none',
  color: '#787c99',
  cursor: 'pointer',
  fontSize: 16,
  flexShrink: 0,
  padding: 0,
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
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  background: 'none',
  border: 'none',
  borderLeft: '1px solid #2a2d3a',
  color: '#787c99',
  cursor: 'pointer',
  fontSize: 18,
  fontWeight: 300,
  flexShrink: 0,
  padding: 0,
  transition: 'color 0.15s, background-color 0.15s',
};

const overflowBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  background: 'none',
  border: 'none',
  borderLeft: '1px solid #2a2d3a',
  color: '#787c99',
  cursor: 'pointer',
  fontSize: 16,
  flexShrink: 0,
  padding: 0,
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
    <div style={tabBarStyle}>
      {showLeftScroll && (
        <button
          style={scrollBtnStyle}
          onClick={() => handleScroll('left')}
          aria-label="Scroll tabs left"
        >
          ‹
        </button>
      )}

      <div style={tabsContainerStyle} ref={tabsContainerRef}>
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
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#a9b1d6';
            e.currentTarget.style.backgroundColor = '#1e2030';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#787c99';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
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
