import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useTheme } from '../contexts/ThemeContext';
import { signOut } from '../lib/auth';
import { useAuth } from './AuthProvider';

/**
 * User menu with avatar and dropdown for user-specific actions.
 * Navigation links have been moved to AppShell sidebar.
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 192;
    const gutter = 8;
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 8,
      left: Math.max(
        gutter,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - gutter)
      ),
      width: menuWidth,
      zIndex: 'var(--sam-z-dropdown)' as unknown as number,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
  }, [isOpen, updateMenuPosition]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  if (!user) return null;

  const avatarElement = user.image ? (
    <img src={user.image} alt={user.name || user.email} className="h-8 w-8 rounded-full" />
  ) : (
    <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-sm font-medium">
      {(user.name || user.email).charAt(0).toUpperCase()}
    </div>
  );

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
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
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </>
        )}
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            className="glass-surface rounded-md shadow-dropdown border border-border-default overflow-hidden"
            style={menuStyle}
          >
            <div className="px-4 py-2 border-b border-border-default">
              <p className="text-sm font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap m-0">
                {user.name || 'User'}
              </p>
              <p className="text-xs text-fg-muted overflow-hidden text-ellipsis whitespace-nowrap m-0">
                {user.email}
              </p>
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-sm text-fg-primary bg-transparent border-none border-b border-border-default cursor-pointer hover:bg-surface-hover"
            >
              <span>{isDark ? 'Light theme' : 'Dark theme'}</span>
              {isDark ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="4" strokeWidth={2} />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.07-7.07l-1.41 1.41M6.34 17.66l-1.41 1.41m12.14 0l-1.41-1.41M6.34 6.34L4.93 4.93"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"
                  />
                </svg>
              )}
            </button>

            <button
              onClick={handleSignOut}
              className="block w-full text-left px-4 py-2 text-sm text-danger-fg bg-transparent border-none cursor-pointer hover:bg-surface-hover"
            >
              Sign out
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
