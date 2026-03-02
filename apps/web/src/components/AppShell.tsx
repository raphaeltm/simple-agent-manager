import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { NavSidebar, NAV_ITEMS } from './NavSidebar';
import { MobileNavDrawer } from './MobileNavDrawer';
import { signOut } from '../lib/auth';

interface AppShellProps {
  children?: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { user, isSuperadmin } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const mobileNavItems = useMemo(() => {
    const items = NAV_ITEMS.map((item) => ({ label: item.label, path: item.path }));
    if (isSuperadmin) {
      items.push({ label: 'Admin', path: '/admin' });
    }
    return items;
  }, [isSuperadmin]);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  const avatarElement = user?.image ? (
    <img
      src={user.image}
      alt={user.name || user.email}
      className="h-7 w-7 rounded-full"
    />
  ) : (
    <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-xs font-medium">
      {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex flex-col bg-canvas h-screen">
        <header className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface">
          {/* Title on the left */}
          <span className="text-lg font-semibold text-fg-primary">
            SAM
          </span>
          {/* Hamburger on the right -- matches drawer slide-in direction */}
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer"
          >
            <Menu size={20} />
          </button>
        </header>

        <main className="flex-1 overflow-y-auto flex flex-col">
          {children ?? <Outlet />}
        </main>

        {drawerOpen && user && (
          <MobileNavDrawer
            onClose={() => setDrawerOpen(false)}
            user={{ name: user.name, email: user.email, image: user.image }}
            navItems={mobileNavItems}
            currentPath={location.pathname}
            onNavigate={(path) => { navigate(path); setDrawerOpen(false); }}
            onSignOut={handleSignOut}
          />
        )}
      </div>
    );
  }

  return (
    <div className="grid bg-canvas h-screen" style={{ gridTemplateColumns: '220px 1fr' }}>
      <aside className="flex flex-col border-r border-border-default bg-surface sticky top-0 h-screen overflow-y-auto">
        <div className="p-4 text-lg font-semibold text-fg-primary border-b border-border-default">SAM</div>
        <NavSidebar />
        {user && (
          <div className="mt-auto p-3 border-t border-border-default flex items-center gap-2">
            {avatarElement}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap">
                {user.name || user.email}
              </div>
            </div>
            <button
              onClick={handleSignOut}
              aria-label="Sign out"
              className="bg-transparent border-none text-fg-muted cursor-pointer p-1 text-xs hover:text-danger-fg transition-colors"
            >
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        )}
      </aside>

      <main className="flex-1 overflow-y-auto flex flex-col">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
