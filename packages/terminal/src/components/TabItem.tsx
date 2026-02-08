import React, { useState, useRef, useEffect } from 'react';
import type { TabItemProps } from '../types/multi-terminal';

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
  isDraggable = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
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
        return '⟳';
      case 'connected':
        return isActive ? '▶' : '';
      case 'disconnected':
        return '⊗';
      case 'error':
        return '⚠';
      default:
        return '';
    }
  };

  const tabClassName = [
    'terminal-tab',
    isActive && 'active',
    session.status,
    isDraggable && 'draggable',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={tabClassName}
      onClick={handleTabClick}
      onDoubleClick={handleDoubleClick}
      role="tab"
      aria-selected={isActive}
      aria-label={`Terminal tab: ${session.name}`}
      tabIndex={0}
      data-session-id={session.id}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="terminal-tab-name-editor"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={handleKeyDown}
          maxLength={50}
          aria-label="Tab name editor"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          <span className="terminal-tab-status-icon">{getStatusIcon()}</span>
          <span className="terminal-tab-title" title={session.name}>
            {session.name}
          </span>
        </>
      )}
      <button
        className="terminal-tab-close"
        onClick={handleCloseClick}
        aria-label={`Close ${session.name}`}
        tabIndex={-1}
      >
        ×
      </button>
    </div>
  );
};