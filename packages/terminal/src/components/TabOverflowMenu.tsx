import React, { useEffect, useRef } from 'react';
import type { TerminalSession } from '../types/multi-terminal';

interface TabOverflowMenuProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 4,
  backgroundColor: '#1e2030',
  border: '1px solid #2a2d3a',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  minWidth: 220,
  maxHeight: 320,
  overflowY: 'auto',
  zIndex: 100,
  padding: '4px 0',
};

const baseItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  border: 'none',
  background: 'none',
  width: '100%',
  textAlign: 'left',
  transition: 'background-color 0.1s',
};

const statusColors: Record<string, string> = {
  connected: '#9ece6a',
  connecting: '#e0af68',
  disconnected: '#787c99',
  error: '#f7768e',
};

/**
 * Dropdown menu for tab overflow
 * Shows all terminals when there are too many tabs
 */
export const TabOverflowMenu: React.FC<TabOverflowMenuProps> = ({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div style={dropdownStyle} ref={menuRef} role="menu">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            style={{
              ...baseItemStyle,
              backgroundColor: isActive ? '#33467c' : 'transparent',
              color: isActive ? '#a9b1d6' : '#787c99',
            }}
            onClick={() => onSelect(session.id)}
            role="menuitem"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(session.id);
              }
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = '#1e2030';
                e.currentTarget.style.color = '#a9b1d6';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#787c99';
              }
            }}
          >
            <span style={{
              fontSize: 8,
              color: statusColors[session.status] || '#787c99',
              flexShrink: 0,
            }}>
              ●
            </span>
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {session.name}
            </span>
            {session.workingDirectory && (
              <span style={{
                fontSize: 11,
                color: '#444b6a',
                flexShrink: 0,
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }} title={session.workingDirectory}>
                {session.workingDirectory.split('/').pop() || '/'}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
