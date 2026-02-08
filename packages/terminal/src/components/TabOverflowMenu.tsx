import React, { useEffect, useRef } from 'react';
import type { TerminalSession } from '../types/multi-terminal';

interface TabOverflowMenuProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

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

  const getStatusSymbol = (status: TerminalSession['status']) => {
    switch (status) {
      case 'connected':
        return '●';
      case 'connecting':
        return '○';
      case 'disconnected':
        return '×';
      case 'error':
        return '⚠';
      default:
        return '';
    }
  };

  return (
    <div className="terminal-tab-overflow-dropdown" ref={menuRef} role="menu">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`terminal-tab-overflow-item ${
            session.id === activeSessionId ? 'active' : ''
          }`}
          onClick={() => onSelect(session.id)}
          role="menuitem"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(session.id);
            }
          }}
        >
          <span className={`status-indicator status-${session.status}`}>
            {getStatusSymbol(session.status)}
          </span>
          <span className="session-name">{session.name}</span>
          {session.workingDirectory && (
            <span className="session-path" title={session.workingDirectory}>
              {session.workingDirectory.split('/').pop() || '/'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};