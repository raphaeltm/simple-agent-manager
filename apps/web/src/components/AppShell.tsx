import { Menu, Monitor, Search, Server, Shield } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { useGlobalCommandPalette } from '../hooks/useGlobalCommandPalette';
import { useIsMobile } from '../hooks/useIsMobile';
import { signOut } from '../lib/auth';
import { isMacPlatform } from '../lib/keyboard-shortcuts';
import { useAuth } from './AuthProvider';
import { GlobalAudioPlayer } from './GlobalAudioPlayer';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { MobileNavDrawer, type MobileNavItem } from './MobileNavDrawer';
import { extractProjectId, GLOBAL_NAV_ITEMS, NavSidebar, PROJECT_NAV_ITEMS } from './NavSidebar';
import { NotificationCenter } from './NotificationCenter';
import { RecentChatsDropdown } from './RecentChatsDropdown';

interface AppShellContextValue {
  setProjectName: (name: string | undefined) => void;
}

const AppShellContext = createContext<AppShellContextValue>({ setProjectName: () => {} });

export function useAppShell() {
  return useContext(AppShellContext);
}

interface AppShellProps {
  children?: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { user, isSuperadmin } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectName, setProjectNameState] = useState<string | undefined>(undefined);
  const [showGlobalNav, setShowGlobalNav] = useState(false);
  const commandPalette = useGlobalCommandPalette();

  const setProjectName = useCallback((name: string | undefined) => {
    setProjectNameState(name);
  }, []);

  const handleToggleGlobalNav = useCallback(() => {
    setShowGlobalNav((prev) => !prev);
  }, []);

  // Detect project context from URL (excludes reserved paths like /projects/new)
  const projectId = extractProjectId(location.pathname);

  const mobileNavItems = useMemo((): MobileNavItem[] => {
    if (projectId) {
      return PROJECT_NAV_ITEMS.map((item) => ({
        label: item.label,
        path: `/projects/${projectId}/${item.path}`,
        icon: item.icon,
      }));
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

  const mobileGlobalNavItems = useMemo((): MobileNavItem[] => {
    const items: MobileNavItem[] = GLOBAL_NAV_ITEMS.map((item) => ({
      label: item.label,
      path: item.path,
      icon: item.icon,
    }));
    if (isSuperadmin) {
      items.push({ label: 'Admin', path: '/admin', icon: <Shield size={18} /> });
    }
    return items;
  }, [isSuperadmin]);

  const mobileInfraSection = useMemo(() => {
    if (!isSuperadmin) return undefined;
    return {
      items: [
        { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
        { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
      ],
    };
  }, [isSuperadmin]);

  // Close drawer and reset nav toggle on route change
  useEffect(() => {
    setDrawerOpen(false);
    setShowGlobalNav(false);
  }, [location.pathname]);

  // Clear project name when leaving project context
  useEffect(() => {
    if (!projectId) {
      setProjectNameState(undefined);
    }
  }, [projectId]);

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

  const shellContext = useMemo(() => ({ setProjectName }), [setProjectName]);

  if (isMobile) {
    return (
      <AppShellContext.Provider value={shellContext}>
      <div className="flex flex-col bg-canvas h-screen">
        <header className="flex items-center justify-between px-4 py-2 border-b border-border-default bg-surface">
          {/* Title on the left */}
          <img src="/sam-head.png" alt="SAM" className="h-7 w-7 object-contain" />
          {/* Search + Notifications + Hamburger on the right */}
          <div className="flex items-center gap-1">
            <button
              onClick={commandPalette.open}
              aria-label="Open command palette"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer"
            >
              <Search size={18} />
            </button>
            <RecentChatsDropdown />
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

        <main className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
          {children ?? <Outlet />}
        </main>

        <GlobalAudioPlayer />

        {drawerOpen && user && (
          <MobileNavDrawer
            onClose={() => setDrawerOpen(false)}
            user={{ name: user.name, email: user.email, image: user.image }}
            navItems={mobileNavItems}
            globalNavItems={projectId ? mobileGlobalNavItems : undefined}
            currentPath={location.pathname}
            onNavigate={(path) => { navigate(path); setDrawerOpen(false); }}
            onSignOut={handleSignOut}
            projectName={projectId ? (projectName || 'Project') : undefined}
            infraSection={mobileInfraSection}
            showGlobalNav={showGlobalNav}
            onToggleGlobalNav={projectId ? handleToggleGlobalNav : undefined}
          />
        )}

        {commandPalette.isOpen && (
          <GlobalCommandPalette onClose={commandPalette.close} />
        )}
      </div>
      </AppShellContext.Provider>
    );
  }

  return (
    <AppShellContext.Provider value={shellContext}>
    <div className="grid bg-canvas h-screen" style={{ gridTemplateColumns: '220px 1fr', gridTemplateRows: '1fr auto' }}>
      <aside className="flex flex-col border-r border-border-default bg-surface sticky top-0 overflow-y-auto" style={{ gridRow: '1' }}>
        <div className="p-4 border-b border-border-default flex items-center justify-between">
          <img src="/sam-head.png" alt="SAM" className="h-6 w-6 object-contain" />
          <div className="flex items-center gap-1">
            <RecentChatsDropdown />
            <NotificationCenter />
          </div>
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
        <NavSidebar
          projectName={projectName}
          showGlobalNav={showGlobalNav}
          onToggleGlobalNav={handleToggleGlobalNav}
        />
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

      <main className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0" style={{ gridRow: '1' }}>
        {children ?? <Outlet />}
      </main>

      <div style={{ gridColumn: '1 / -1', gridRow: '2' }}>
        <GlobalAudioPlayer />
      </div>

      {commandPalette.isOpen && (
        <GlobalCommandPalette onClose={commandPalette.close} />
      )}
    </div>
    </AppShellContext.Provider>
  );
}
