import { useState, useRef, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { signOut } from '../lib/auth';

/**
 * User menu with avatar and dropdown for user-specific actions.
 * Navigation links have been moved to AppShell sidebar.
 */
export function UserMenu() {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  if (!user) return null;

  const avatarElement = user.image ? (
    <img
      src={user.image}
      alt={user.name || user.email}
      style={{ height: 32, width: 32, borderRadius: '50%' }}
    />
  ) : (
    <div style={{
      height: 32,
      width: 32,
      borderRadius: '50%',
      backgroundColor: 'var(--sam-color-accent-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontSize: 'var(--sam-type-secondary-size)',
      fontWeight: 500,
    }}>
      {(user.name || user.email).charAt(0).toUpperCase()}
    </div>
  );

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sam-space-2)',
          color: 'var(--sam-color-fg-muted)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 'var(--sam-space-1)',
        }}
      >
        {avatarElement}
        <span style={{ fontSize: 'var(--sam-type-secondary-size)', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>
          {user.name || user.email}
        </span>
        <svg
          style={{ height: 16, width: 16, transition: 'transform 150ms', transform: isOpen ? 'rotate(180deg)' : 'none' }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div style={{
          position: 'absolute',
          right: 0,
          marginTop: 'var(--sam-space-2)',
          width: '12rem',
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderRadius: 'var(--sam-radius-md)',
          boxShadow: 'var(--sam-shadow-dropdown)',
          border: '1px solid var(--sam-color-border-default)',
          zIndex: 'var(--sam-z-dropdown)',
          overflow: 'hidden',
        }}>
          <div style={{ padding: 'var(--sam-space-2) var(--sam-space-4)', borderBottom: '1px solid var(--sam-color-border-default)' }}>
            <p style={{ fontSize: 'var(--sam-type-secondary-size)', fontWeight: 500, color: 'var(--sam-color-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {user.name || 'User'}
            </p>
            <p style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {user.email}
            </p>
          </div>

          <button
            onClick={handleSignOut}
            className="sam-user-menu-item"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: 'var(--sam-space-2) var(--sam-space-4)',
              fontSize: 'var(--sam-type-secondary-size)',
              color: 'var(--sam-color-danger)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      )}

      <style>{`
        .sam-user-menu-item:hover {
          background: var(--sam-color-bg-surface-hover);
        }
      `}</style>
    </div>
  );
}
