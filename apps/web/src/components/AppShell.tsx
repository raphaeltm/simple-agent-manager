import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Search, ArrowLeft, Shield, Server, Monitor } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { NavSidebar, GLOBAL_NAV_ITEMS, PROJECT_NAV_ITEMS, extractProjectId } from './NavSidebar';
import { MobileNavDrawer, type MobileNavItem } from './MobileNavDrawer';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { useGlobalCommandPalette } from '../hooks/useGlobalCommandPalette';
import { isMacPlatform } from '../lib/keyboard-shortcuts';
import { signOut } from '../lib/auth';
import { NotificationCenter } from './NotificationCenter';

interface AppShellProps {
  children?: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { user, isSuperadmin } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const commandPalette = useGlobalCommandPalette();

  // Detect project context from URL (excludes reserved paths like /projects/new)
  const projectId = extractProjectId(location.pathname);

  const mobileNavItems = useMemo((): MobileNavItem[] => {
    if (projectId) {
      return [
        { label: 'Back to Projects', path: '/projects', icon: <ArrowLeft size={18} /> },
        ...PROJECT_NAV_ITEMS.map((item) => ({
          label: item.label,
          path: `/projects/${projectId}/${item.path}`,
          icon: item.icon,
        })),
      ];
    }
    const items: MobileNavItem[] = GLOBAL_NAV_ITEMS.map((item) => ({
      label: item.label,
      path: item.path,
      icon: item.icon,
    }));
    if (isSuperadmin) {
      items.push({ label: 'Admin', path: '/admin', icon: <Shield size={18} /> });
    }
    return items;
  }, [isSuperadmin, projectId]);

  const mobileInfraSection = useMemo(() => {
    if (!isSuperadmin || projectId) return undefined;
    return {
      items: [
        { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
        { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
      ],
    };
  }, [isSuperadmin, projectId]);

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
          <img src="/favicon.png" alt="SAM" className="h-7 w-7" />
          {/* Search + Notifications + Hamburger on the right */}
          <div className="flex items-center gap-1">
            <button
              onClick={commandPalette.open}
              aria-label="Open command palette"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer"
            >
              <Search size={18} />
            </button>
            <NotificationCenter />
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer"
            >
              <Menu size={20} />
            </button>
          </div>
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
            projectName={projectId ? 'Project' : undefined}
            infraSection={mobileInfraSection}
          />
        )}

        {commandPalette.isOpen && (
          <GlobalCommandPalette onClose={commandPalette.close} />
        )}
      </div>
    );
  }

  return (
    <div className="grid bg-canvas h-screen" style={{ gridTemplateColumns: '220px 1fr' }}>
      <aside className="flex flex-col border-r border-border-default bg-surface sticky top-0 h-screen overflow-y-auto">
        <div className="p-4 border-b border-border-default flex items-center justify-between">
          <img src="/favicon.png" alt="SAM" className="h-6 w-6" />
          <NotificationCenter />
        </div>
        {/* Command palette trigger */}
        <button
          onClick={commandPalette.open}
          className="mx-2 mt-2 flex items-center gap-2 px-3 py-1.5 rounded-sm bg-transparent border border-border-default text-fg-muted text-xs cursor-pointer hover:bg-surface-hover hover:text-fg-primary transition-colors"
          aria-label="Open command palette"
        >
          <Search size={12} />
          <span className="flex-1 text-left">Search...</span>
          <kbd className="font-mono text-[10px] bg-inset border border-border-default rounded px-1 py-0.5">
            {isMacPlatform() ? '\u2318K' : 'Ctrl+K'}
          </kbd>
        </button>
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

      {commandPalette.isOpen && (
        <GlobalCommandPalette onClose={commandPalette.close} />
      )}
    </div>
  );
}
