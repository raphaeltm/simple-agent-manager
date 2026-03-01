import { useState, useRef, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { signOut } from '../lib/auth';

/**
 * User menu with avatar and dropdown for user-specific actions.
 * Navigation links have been moved to AppShell sidebar.
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
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
      className="h-8 w-8 rounded-full"
    />
  ) : (
    <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-sm font-medium">
      {(user.name || user.email).charAt(0).toUpperCase()}
    </div>
  );

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-fg-muted bg-transparent border-none cursor-pointer p-1"
      >
        {avatarElement}
        {!compact && (
          <>
            <span className="text-sm font-medium text-fg-primary max-w-30 overflow-hidden text-ellipsis whitespace-nowrap">
              {user.name || user.email}
            </span>
            <svg
              className="h-4 w-4 transition-transform duration-150"
              style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-surface rounded-md shadow-dropdown border border-border-default z-dropdown overflow-hidden">
          <div className="px-4 py-2 border-b border-border-default">
            <p className="text-sm font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap m-0">
              {user.name || 'User'}
            </p>
            <p className="text-xs text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap m-0">
              {user.email}
            </p>
          </div>

          <button
            onClick={handleSignOut}
            className="block w-full text-left px-4 py-2 text-sm text-danger-fg bg-transparent border-none cursor-pointer hover:bg-surface-hover"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
