import React, { useEffect, useRef } from 'react';

import { applyHoverIn, applyHoverOut, colors, dimensions, ellipsisText, fonts, getStatusColor } from '../terminal-tokens';
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
  backgroundColor: colors.bgSurface,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  boxShadow: `0 8px 24px ${colors.shadow}`,
  minWidth: dimensions.menuMinWidth,
  maxHeight: dimensions.menuMaxHeight,
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
  fontFamily: fonts.ui,
  border: 'none',
  background: 'none',
  width: '100%',
  textAlign: 'left',
  transition: 'background-color 0.1s',
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

  // Close on click-outside or Escape key
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div style={dropdownStyle} ref={menuRef} role="menu">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            style={{
              ...baseItemStyle,
              backgroundColor: isActive ? colors.bgHighlight : 'transparent',
              color: isActive ? colors.fg : colors.fgMuted,
            }}
            onClick={() => onSelect(session.id)}
            role="menuitem"
            onMouseEnter={(e) => { if (!isActive) applyHoverIn(e.currentTarget); }}
            onMouseLeave={(e) => { if (!isActive) applyHoverOut(e.currentTarget); }}
          >
            <span style={{
              fontSize: 8,
              color: getStatusColor(session.status),
              flexShrink: 0,
            }}>
              ●
            </span>
            <span style={{
              ...ellipsisText,
              flex: 1,
            }}>
              {session.name}
            </span>
            {session.workingDirectory && (
              <span style={{
                fontSize: 11,
                color: colors.fgDim,
                flexShrink: 0,
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }} title={session.workingDirectory}>
                {session.workingDirectory.split('/').pop() || '/'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
