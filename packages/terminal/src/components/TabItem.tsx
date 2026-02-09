import React, { useState, useRef, useEffect } from 'react';
import type { TabItemProps } from '../types/multi-terminal';

const baseTabStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 12px',
  minWidth: 100,
  maxWidth: 180,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  borderRight: '1px solid #2a2d3a',
  position: 'relative',
  transition: 'background-color 0.15s',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const activeTabStyle: React.CSSProperties = {
  ...baseTabStyle,
  backgroundColor: '#1a1b26',
  color: '#a9b1d6',
};

const inactiveTabStyle: React.CSSProperties = {
  ...baseTabStyle,
  backgroundColor: 'transparent',
  color: '#787c99',
};

const activeIndicatorStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  height: 2,
  backgroundColor: '#7aa2f7',
};

const closeBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 4,
  background: 'none',
  border: 'none',
  color: '#787c99',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
  transition: 'background-color 0.15s, color 0.15s',
};

const statusIconStyle: React.CSSProperties = {
  fontSize: 10,
  flexShrink: 0,
  lineHeight: 1,
};

const tabTitleStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const nameEditorStyle: React.CSSProperties = {
  background: '#1e2030',
  border: '1px solid #7aa2f7',
  borderRadius: 3,
  color: '#a9b1d6',
  fontSize: 13,
  fontFamily: 'inherit',
  padding: '1px 4px',
  outline: 'none',
  width: '100%',
  minWidth: 0,
};

/**
 * Individual terminal tab component
 * Displays tab name, active state, close button, and supports renaming
 */
export const TabItem: React.FC<TabItemProps> = ({
  session,
  isActive,
  onActivate,
  onClose,
  onRename,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [isHovered, setIsHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleDoubleClick = () => {
    setIsEditing(true);
    setEditName(session.name);
  };

  const handleRename = () => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== session.name) {
      onRename(session.id, trimmedName.slice(0, 50));
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      setEditName(session.name);
      setIsEditing(false);
    }
  };

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(session.id);
  };

  const handleTabClick = () => {
    if (!isActive && !isEditing) {
      onActivate(session.id);
    }
  };

  const getStatusIcon = () => {
    switch (session.status) {
      case 'connecting':
        return { icon: '●', color: '#e0af68' }; // yellow
      case 'connected':
        return { icon: '●', color: '#9ece6a' }; // green
      case 'disconnected':
        return { icon: '●', color: '#787c99' }; // grey
      case 'error':
        return { icon: '●', color: '#f7768e' }; // red
      default:
        return { icon: '●', color: '#787c99' };
    }
  };

  const status = getStatusIcon();

  const tabStyle: React.CSSProperties = isActive
    ? activeTabStyle
    : isHovered
      ? { ...inactiveTabStyle, backgroundColor: '#1e2030', color: '#a9b1d6' }
      : inactiveTabStyle;

  return (
    <div
      style={tabStyle}
      onClick={handleTabClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="tab"
      aria-selected={isActive}
      aria-label={`Terminal tab: ${session.name}`}
      tabIndex={0}
      data-session-id={session.id}
    >
      {/* Active indicator bar */}
      {isActive && <div style={activeIndicatorStyle} />}

      {/* Status dot */}
      <span style={{ ...statusIconStyle, color: status.color }}>{status.icon}</span>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          style={nameEditorStyle}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={handleKeyDown}
          maxLength={50}
          aria-label="Tab name editor"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span style={tabTitleStyle} title={session.name}>
          {session.name}
        </span>
      )}

      {/* Close button - always visible on active tab, shown on hover for others */}
      <button
        style={{
          ...closeBtnStyle,
          opacity: isActive || isHovered ? 1 : 0,
        }}
        onClick={handleCloseClick}
        aria-label={`Close ${session.name}`}
        tabIndex={-1}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#33467c';
          e.currentTarget.style.color = '#a9b1d6';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
          e.currentTarget.style.color = '#787c99';
        }}
      >
        ×
      </button>
    </div>
  );
};
