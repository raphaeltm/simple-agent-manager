import React, { useEffect,useRef, useState } from 'react';

import { applyHoverOut, colors, dimensions, ellipsisText, fonts, getStatusColor } from '../terminal-tokens';
import type { TabItemProps } from '../types/multi-terminal';

const baseTabStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 12px',
  minWidth: dimensions.tabMinWidth,
  maxWidth: dimensions.tabMaxWidth,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: fonts.ui,
  borderRight: `1px solid ${colors.border}`,
  position: 'relative',
  transition: 'background-color 0.15s',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const activeTabStyle: React.CSSProperties = {
  ...baseTabStyle,
  backgroundColor: colors.bg,
  color: colors.fg,
};

const inactiveTabStyle: React.CSSProperties = {
  ...baseTabStyle,
  backgroundColor: 'transparent',
  color: colors.fgMuted,
};

const activeIndicatorStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  height: 2,
  backgroundColor: colors.accent,
};

const closeBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: dimensions.closeBtnSize,
  height: dimensions.closeBtnSize,
  borderRadius: 4,
  background: 'none',
  border: 'none',
  color: colors.fgMuted,
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
  ...ellipsisText,
  flex: 1,
  minWidth: 0,
};

const nameEditorStyle: React.CSSProperties = {
  background: colors.bgSurface,
  border: `1px solid ${colors.accent}`,
  borderRadius: 3,
  color: colors.fg,
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
  tabIndex,
  onActivate,
  onClose,
  onRename,
  onKeyDown,
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

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
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

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(e, session.id);

    if (e.defaultPrevented) return;

    if (e.key === 'Enter' || e.key === ' ') {
      if (!isActive && !isEditing) {
        e.preventDefault();
        onActivate(session.id);
      }
    }
  };

  const statusColor = getStatusColor(session.status);

  const tabStyle: React.CSSProperties = isActive
    ? activeTabStyle
    : isHovered
      ? { ...inactiveTabStyle, backgroundColor: colors.bgSurface, color: colors.fg }
      : inactiveTabStyle;

  return (
    <div
      style={tabStyle}
      onClick={handleTabClick}
      onKeyDown={handleTabKeyDown}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="tab"
      aria-selected={isActive}
      aria-label={`Terminal tab: ${session.name}`}
      tabIndex={tabIndex}
      data-session-id={session.id}
    >
      {/* Active indicator bar */}
      {isActive && <div style={activeIndicatorStyle} />}

      {/* Status dot */}
      <span style={{ ...statusIconStyle, color: statusColor }}>●</span>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          style={nameEditorStyle}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={handleInputKeyDown}
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
        tabIndex={0}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = colors.bgHighlight;
          e.currentTarget.style.color = colors.fg;
        }}
        onMouseLeave={(e) => applyHoverOut(e.currentTarget)}
      >
        ×
      </button>
    </div>
  );
};
