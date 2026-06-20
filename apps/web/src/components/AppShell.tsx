import { Menu, Monitor, Search, Server, Shield } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';

import { useGlobalCommandPalette } from '../hooks/useGlobalCommandPalette';
import { useIsMobile } from '../hooks/useIsMobile';
import { useProjectList } from '../hooks/useProjectData';
import { signOut } from '../lib/auth';
import {
  type FocusMode,
  FOCUS_MODE_STORAGE_KEY,
  isFocusMode,
  navWidthForMode,
  nextFocusMode,
} from '../lib/focus-mode';
import { isMacPlatform } from '../lib/keyboard-shortcuts';
import { useAuth } from './AuthProvider';
import { CredentialHealthNavItem } from './CredentialHealthNavItem';
import { FocusModeToggle } from './FocusModeToggle';
import { GlobalAudioPlayer } from './GlobalAudioPlayer';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { MobileNavDrawer, type MobileNavItem } from './MobileNavDrawer';
import { extractProjectId, GLOBAL_NAV_ITEMS, NavSidebar, PROJECT_NAV_ITEMS } from './NavSidebar';
import { NotificationCenter } from './NotificationCenter';
import { OnboardingProvider } from './onboarding';
import { ChoosePathWizard } from './onboarding/choose-path/ChoosePathWizard';
import { RecentChatsDropdown } from './RecentChatsDropdown';
import { SidebarProjectList } from './SidebarProjectList';
import { ThemeSwitcher } from './ThemeSwitcher';
import { ZenPeekRail } from './ZenPeekRail';

interface AppShellContextValue {
  setProjectName: (name: string | undefined) => void;
  /** Current desktop Focus Mode. Always `default` on mobile. */
  focusMode: FocusMode;
  setFocusMode: (mode: FocusMode) => void;
  /** Advance default → focus → zen → default. */
  cycleFocusMode: () => void;
}

const AppShellContext = createContext<AppShellContextValue>({
  setProjectName: () => {},
  focusMode: 'default',
  setFocusMode: () => {},
  cycleFocusMode: () => {},
});

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
  const [focusModeState, setFocusModeState] = useState<FocusMode>('default');
  const commandPalette = useGlobalCommandPalette();
  const { projects: sidebarProjects, loading: sidebarProjectsLoading } = useProjectList({
    limit: 50,
    pollInterval: 60000,
  });

  const setProjectName = useCallback((name: string | undefined) => {
    setProjectNameState(name);
  }, []);

  const handleToggleGlobalNav = useCallback(() => {
    setShowGlobalNav((prev) => !prev);
  }, []);

  const setFocusMode = useCallback((mode: FocusMode) => {
    setFocusModeState(mode);
    try {
      window.localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage unavailable (private mode / quota) — in-memory state still works.
    }
  }, []);

  const cycleFocusMode = useCallback(() => {
    setFocusModeState((prev) => {
      const next = nextFocusMode(prev);
      try {
        window.localStorage.setItem(FOCUS_MODE_STORAGE_KEY, next);
      } catch {
        // ignore persistence failure
      }
      return next;
    });
  }, []);

  // Hydrate Focus Mode from localStorage (desktop only). Mobile always uses default.
  useEffect(() => {
    if (isMobile) return;
    try {
      const stored = window.localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
      if (isFocusMode(stored)) {
        setFocusModeState(stored);
      }
    } catch {
      // ignore
    }
  }, [isMobile]);

  // "F" cycles Focus Mode (desktop only). Ignore when typing in inputs.
  useEffect(() => {
    if (isMobile) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      )
        return;
      e.preventDefault();
      cycleFocusMode();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isMobile, cycleFocusMode]);

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
    return {
      items: [
        { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
        { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
      ],
    };
  }, []);

  const handleProjectNavigate = useCallback(
    (path: string) => {
      navigate(path);
      setDrawerOpen(false);
    },
    [navigate],
  );

  const mobileProjectListSection = useMemo(
    () => (
      <SidebarProjectList
        projects={sidebarProjects}
        loading={sidebarProjectsLoading}
        currentProjectId={projectId}
        onNavigate={handleProjectNavigate}
        variant="mobile"
      />
    ),
    [sidebarProjects, sidebarProjectsLoading, projectId, handleProjectNavigate],
  );

  const desktopProjectListSection = useMemo(
    () => (
      <SidebarProjectList
        projects={sidebarProjects}
        loading={sidebarProjectsLoading}
        currentProjectId={projectId}
        onNavigate={handleProjectNavigate}
        variant="desktop"
      />
    ),
    [sidebarProjects, sidebarProjectsLoading, projectId, handleProjectNavigate],
  );

  const projectHealthElement = projectId ? (
    <CredentialHealthNavItem projectId={projectId} />
  ) : null;

  const mobileProjectHealthElement = projectId ? (
    <CredentialHealthNavItem projectId={projectId} compact />
  ) : null;

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

  // Focus Mode is desktop-only — force `default` on mobile so session-sidebar
  // consumers never collapse on small viewports.
  const focusMode: FocusMode = isMobile ? 'default' : focusModeState;

  const shellContext = useMemo(
    () => ({ setProjectName, focusMode, setFocusMode, cycleFocusMode }),
    [setProjectName, focusMode, setFocusMode, cycleFocusMode],
  );

  if (isMobile) {
    return (
      <AppShellContext.Provider value={shellContext}>
      <OnboardingProvider>
      <ChoosePathWizard />
      <div className="flex flex-col h-screen">
        <header className="relative z-30 flex items-center justify-between px-4 py-2 glass-chrome glass-panel-container glass-composited border-x-0 border-t-0 after:content-[''] after:absolute after:bottom-0 after:left-[10%] after:right-[10%] after:h-0.5 after:bg-[radial-gradient(ellipse_at_center,var(--sam-chrome-accent-glow)_0%,transparent_70%)] after:blur-[1px] after:pointer-events-none">
          {/* Title on the left */}
          <Link to="/dashboard">
            <img src="/sam-head.png" alt="SAM" className="h-7 w-7 object-contain" />
          </Link>
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

        <main className="sam-main-content flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
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
            projectListSection={mobileProjectListSection}
            projectHealthElement={mobileProjectHealthElement}
            showGlobalNav={showGlobalNav}
            onToggleGlobalNav={projectId ? handleToggleGlobalNav : undefined}
          />
        )}

        {commandPalette.isOpen && (
          <GlobalCommandPalette onClose={commandPalette.close} />
        )}
      </div>
      </OnboardingProvider>
      </AppShellContext.Provider>
    );
  }

  return (
    <AppShellContext.Provider value={shellContext}>
    <OnboardingProvider>
    <ChoosePathWizard />
    <div
      className="grid h-screen overflow-hidden transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateColumns: `${navWidthForMode(focusMode)}px 1fr`, gridTemplateRows: 'minmax(0, 1fr) auto' }}
    >
      {/* Announce Focus Mode changes to assistive tech (mode is cycled via the
          "F" key or the toggle, so screen readers need a live region). */}
      <div aria-live="polite" className="sr-only">
        {focusMode === 'default'
          ? 'Default view'
          : focusMode === 'focus'
            ? 'Focus mode: sidebars collapsed'
            : 'Zen mode: sidebars hidden'}
      </div>
      {focusMode === 'zen' ? (
        <ZenPeekRail
          edge="nav"
          label="Navigation"
          onExpand={() => setFocusMode('default')}
          gridRow="1"
        >
          <NavSidebar
            projectName={projectName}
            showGlobalNav={showGlobalNav}
            onToggleGlobalNav={handleToggleGlobalNav}
            projectListSection={desktopProjectListSection}
            projectHealthElement={projectHealthElement}
          />
        </ZenPeekRail>
      ) : (
        <aside className="relative z-30 glass-panel-container glass-composited flex flex-col glass-chrome border-y-0 border-l-0 overflow-y-auto overflow-x-hidden" style={{ gridRow: '1' }}>
          <div className={`p-4 border-b border-border-default flex items-center ${focusMode === 'focus' ? 'justify-center' : 'justify-between'}`}>
            <img src="/sam-head.png" alt="SAM" className="h-6 w-6 object-contain" />
            {focusMode !== 'focus' && (
              <div className="flex items-center gap-1">
                <RecentChatsDropdown />
                <NotificationCenter />
              </div>
            )}
          </div>
          {/* Command palette trigger */}
          {focusMode === 'focus' ? (
            <button
              onClick={commandPalette.open}
              className="mx-2 mt-2 flex items-center justify-center h-9 rounded-sm bg-transparent border border-border-default text-fg-muted cursor-pointer hover:bg-surface-hover hover:text-fg-primary transition-colors"
              aria-label="Open command palette"
              title="Search..."
            >
              <Search size={16} />
            </button>
          ) : (
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
          )}
          <NavSidebar
            projectName={projectName}
            showGlobalNav={showGlobalNav}
            onToggleGlobalNav={handleToggleGlobalNav}
            projectListSection={desktopProjectListSection}
            projectHealthElement={projectHealthElement}
            iconOnly={focusMode === 'focus'}
          />
          <div className={`mt-auto ${focusMode === 'focus' ? 'px-1 py-2' : 'px-2 py-2'}`}>
            <FocusModeToggle
              mode={focusMode}
              onSelect={setFocusMode}
              onCycle={cycleFocusMode}
              variant={focusMode === 'focus' ? 'cycle' : 'segmented'}
            />
          </div>
          {user && (
            <div className="border-t border-[var(--sam-glass-border-color)] bg-[var(--sam-chrome-footer-bg)]">
              {focusMode === 'focus' ? (
                <div className="p-2 flex flex-col items-center gap-2">
                  {avatarElement}
                  <button
                    onClick={handleSignOut}
                    aria-label="Sign out"
                    title="Sign out"
                    className="bg-transparent border-none text-fg-muted cursor-pointer p-1 text-xs hover:text-danger-fg transition-colors"
                  >
                    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                  </button>
                </div>
              ) : (
                <>
                  <div className="px-3 pt-3">
                    <ThemeSwitcher />
                  </div>
                  <div className="p-3 flex items-center gap-2">
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
                </>
              )}
            </div>
          )}
        </aside>
      )}

      <main className="sam-main-content flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0" style={{ gridRow: '1' }}>
        {children ?? <Outlet />}
      </main>

      <div style={{ gridColumn: '1 / -1', gridRow: '2' }}>
        <GlobalAudioPlayer />
      </div>

      {commandPalette.isOpen && (
        <GlobalCommandPalette onClose={commandPalette.close} />
      )}
    </div>
    </OnboardingProvider>
    </AppShellContext.Provider>
  );
}
