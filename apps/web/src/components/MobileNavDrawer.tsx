import { useEffect } from 'react';

interface NavItem {
  label: string;
  path: string;
}

interface MobileNavDrawerProps {
  onClose: () => void;
  user: { name?: string | null; email: string; image?: string | null };
  navItems: NavItem[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
}

function isNavItemActive(path: string, pathname: string): boolean {
  if (path === '/dashboard') {
    return pathname === '/dashboard';
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function MobileNavDrawer({
  onClose,
  user,
  navItems,
  currentPath,
  onNavigate,
  onSignOut,
}: MobileNavDrawerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="mobile-nav-backdrop"
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        style={{ animation: 'sam-drawer-fade-in 0.15s ease-out' }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-label="Navigation menu"
        data-testid="mobile-nav-panel"
        className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-80 bg-surface border-l border-border-default z-drawer flex flex-col overflow-hidden"
        style={{ animation: 'sam-drawer-slide-in 0.2s ease-out' }}
      >
        {/* Header: user info + close */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default">
          {user.image ? (
            <img
              src={user.image}
              alt={user.name || user.email}
              className="h-9 w-9 rounded-full shrink-0"
            />
          ) : (
            <div className="h-9 w-9 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-sm font-medium shrink-0">
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-fg-primary m-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {user.name || 'User'}
            </p>
            <p className="text-xs text-fg-muted m-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {user.email}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="flex items-center justify-center w-8 h-8 bg-transparent border-none text-fg-muted cursor-pointer shrink-0"
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Nav items */}
        <nav aria-label="Primary navigation" className="flex-1 pt-2">
          {navItems.map((item) => {
            const active = isNavItemActive(item.path, currentPath);
            return (
              <button
                key={item.path}
                className={`flex items-center w-full min-h-11 px-5 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${
                  active
                    ? 'text-accent border-l-accent bg-accent-tint'
                    : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                }`}
                onClick={() => onNavigate(item.path)}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Sign out */}
        <div className="border-t border-border-default py-2">
          <button
            onClick={onSignOut}
            className="flex items-center w-full min-h-11 px-5 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 border-l-transparent text-danger-fg hover:bg-surface-hover transition-all duration-[120ms]"
          >
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}
