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
      <style>{`
        @keyframes sam-drawer-slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes sam-drawer-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .sam-mobile-nav-item {
          display: flex;
          align-items: center;
          width: 100%;
          min-height: 44px;
          padding: 0.625rem 1.25rem;
          font-size: 0.9375rem;
          font-weight: 500;
          color: var(--sam-color-fg-muted);
          background: none;
          border: none;
          cursor: pointer;
          text-align: left;
          border-left: 3px solid transparent;
          transition: all 0.12s ease;
        }
        .sam-mobile-nav-item:hover {
          color: var(--sam-color-fg-primary);
          background: color-mix(in srgb, var(--sam-color-bg-surface) 72%, transparent);
        }
        .sam-mobile-nav-item.is-active {
          color: var(--sam-color-accent-primary);
          border-left-color: var(--sam-color-accent-primary);
          background: color-mix(in srgb, var(--sam-color-accent-primary) 10%, transparent);
        }
      `}</style>

      {/* Backdrop */}
      <div
        data-testid="mobile-nav-backdrop"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 50,
          animation: 'sam-drawer-fade-in 0.15s ease-out',
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-label="Navigation menu"
        data-testid="mobile-nav-panel"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '85vw',
          maxWidth: 320,
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderLeft: '1px solid var(--sam-color-border-default)',
          zIndex: 51,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'sam-drawer-slide-in 0.2s ease-out',
        }}
      >
        {/* Header: user info + close */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--sam-color-border-default)',
          }}
        >
          {user.image ? (
            <img
              src={user.image}
              alt={user.name || user.email}
              style={{ height: 36, width: 36, borderRadius: '50%', flexShrink: 0 }}
            />
          ) : (
            <div
              style={{
                height: 36,
                width: 36,
                borderRadius: '50%',
                backgroundColor: 'var(--sam-color-accent-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: '0.875rem',
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--sam-color-fg-primary)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.name || 'User'}
            </p>
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--sam-color-fg-muted)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.email}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close navigation"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              background: 'none',
              border: 'none',
              color: 'var(--sam-color-fg-muted)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Nav items */}
        <nav aria-label="Primary navigation" style={{ flex: 1, paddingTop: '0.5rem' }}>
          {navItems.map((item) => (
            <button
              key={item.path}
              className={`sam-mobile-nav-item${isNavItemActive(item.path, currentPath) ? ' is-active' : ''}`}
              onClick={() => onNavigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Sign out */}
        <div style={{ borderTop: '1px solid var(--sam-color-border-default)', padding: '0.5rem 0' }}>
          <button
            onClick={onSignOut}
            className="sam-mobile-nav-item"
            style={{ color: 'var(--sam-color-danger)' }}
          >
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}
