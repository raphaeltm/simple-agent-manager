import { Shield } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { useGlobalCommandPalette } from '../hooks/useGlobalCommandPalette';
import { useIsMobile } from '../hooks/useIsMobile';
import { useProjectList } from '../hooks/useProjectData';
import { useSamSettings } from '../hooks/useSamSettings';
import { signOut } from '../lib/auth';
import {
  FOCUS_MODE_STORAGE_KEY,
  type FocusMode,
  isFocusMode,
  navWidthForMode,
  nextFocusMode,
} from '../lib/focus-mode';
import { PROJECT_LIST_LIMIT, SIDEBAR_PROJECT_POLL_INTERVAL_MS } from '../lib/project-query-config';
import { isFullBleedRoute } from '../lib/shell-routes';
import { useAuth } from './AuthProvider';
import { CredentialHealthNavItem } from './CredentialHealthNavItem';
import { GlobalAudioPlayer } from './GlobalAudioPlayer';
import { GlobalCommandPalette } from './GlobalCommandPalette';
import { MobileNavDrawer, type MobileNavItem } from './MobileNavDrawer';
import { extractProjectId, getGlobalNavItems, NavSidebar, PROJECT_NAV_ITEMS } from './NavSidebar';
import { OnboardingProvider } from './onboarding';
import { ChoosePathWizard } from './onboarding/choose-path/ChoosePathWizard';
import { ChatImmersiveContext } from './shell/chat-immersive-context';
import { DesktopSidebar } from './shell/DesktopSidebar';
import { MobileAppBar, type ShellScreenAction } from './shell/MobileAppBar';
import { SidebarProjectList } from './SidebarProjectList';
import { SkipToContent } from './SkipToContent';
import { ZenPeekRail } from './ZenPeekRail';

interface AppShellContextValue {
  setProjectName: (name: string | undefined) => void;
  /** Current desktop Focus Mode. Always `default` on mobile. */
  focusMode: FocusMode;
  setFocusMode: (mode: FocusMode) => void;
  /** Advance default → focus → zen → default. */
  cycleFocusMode: () => void;
  /**
   * Register the screen's main toggle for the mobile app bar (the chat list button on the
   * chat). Pass a memoized value and clear it with `null` on unmount.
   */
  setScreenAction: (action: ShellScreenAction | null) => void;
}

const AppShellContext = createContext<AppShellContextValue>({
  setProjectName: () => {},
  focusMode: 'default',
  setFocusMode: () => {},
  cycleFocusMode: () => {},
  setScreenAction: () => {},
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
  const sam = useSamSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectName, setProjectNameState] = useState<string | undefined>(undefined);
  const [showGlobalNav, setShowGlobalNav] = useState(false);
  const [focusModeState, setFocusModeState] = useState<FocusMode>('default');
  const [screenAction, setScreenAction] = useState<ShellScreenAction | null>(null);
  const [chatImmersiveOn, setChatImmersiveOn] = useState(false);
  const commandPalette = useGlobalCommandPalette();
  const {
    projects: sidebarProjects,
    loading: sidebarProjectsLoading,
    error: sidebarProjectsError,
  } = useProjectList({
    queryScope: user?.id ?? '',
    limit: PROJECT_LIST_LIMIT,
    pollInterval: SIDEBAR_PROJECT_POLL_INTERVAL_MS,
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
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable)
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
    const items: MobileNavItem[] = getGlobalNavItems(sam.enabled).map((item) => ({
      label: item.label,
      path: item.path,
      icon: item.icon,
    }));
    if (isSuperadmin) {
      items.push({ label: 'Admin', path: '/admin', icon: <Shield size={18} /> });
    }
    return items;
  }, [isSuperadmin, projectId, sam.enabled]);

  const mobileGlobalNavItems = useMemo((): MobileNavItem[] => {
    const items: MobileNavItem[] = getGlobalNavItems(sam.enabled).map((item) => ({
      label: item.label,
      path: item.path,
      icon: item.icon,
    }));
    if (isSuperadmin) {
      items.push({ label: 'Admin', path: '/admin', icon: <Shield size={18} /> });
    }
    return items;
  }, [isSuperadmin, sam.enabled]);

  const handleProjectNavigate = useCallback(
    (path: string) => {
      navigate(path);
      setDrawerOpen(false);
    },
    [navigate]
  );

  const mobileProjectListSection = useMemo(
    () => (
      <SidebarProjectList
        projects={sidebarProjects}
        loading={sidebarProjectsLoading}
        error={sidebarProjectsError}
        currentProjectId={projectId}
        onNavigate={handleProjectNavigate}
        queryScope={user?.id ?? ''}
        variant="mobile"
      />
    ),
    [
      sidebarProjects,
      sidebarProjectsLoading,
      sidebarProjectsError,
      projectId,
      handleProjectNavigate,
      user?.id,
    ]
  );

  const desktopProjectListSection = useMemo(
    () => (
      <SidebarProjectList
        projects={sidebarProjects}
        loading={sidebarProjectsLoading}
        error={sidebarProjectsError}
        currentProjectId={projectId}
        onNavigate={handleProjectNavigate}
        queryScope={user?.id ?? ''}
        variant="desktop"
      />
    ),
    [
      sidebarProjects,
      sidebarProjectsLoading,
      sidebarProjectsError,
      projectId,
      handleProjectNavigate,
      user?.id,
    ]
  );

  const projectHealthElement = projectId ? <CredentialHealthNavItem projectId={projectId} /> : null;

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

  // Focus Mode is desktop-only — force `default` on mobile so session-sidebar
  // consumers never collapse on small viewports.
  const focusMode: FocusMode = isMobile ? 'default' : focusModeState;

  // The immersive chat view is phone-only; leaving the phone layout always ends it.
  const chatImmersive = isMobile && chatImmersiveOn;
  useEffect(() => {
    if (!isMobile) setChatImmersiveOn(false);
  }, [isMobile]);
  const chatImmersiveContext = useMemo(
    () => ({ active: chatImmersive, setActive: setChatImmersiveOn }),
    [chatImmersive]
  );

  const shellContext = useMemo(
    () => ({ setProjectName, focusMode, setFocusMode, cycleFocusMode, setScreenAction }),
    [setProjectName, focusMode, setFocusMode, cycleFocusMode]
  );

  // Every routed page except the chat surfaces sits in one content pane; the chat surfaces
  // lay out their own panes over the void. The frame element exists in both cases (as
  // `display: contents` when bare) so switching between them never remounts the page.
  const bareMain = isFullBleedRoute(location.pathname);
  const mainFrameClassName = bareMain
    ? 'contents'
    : 'sam-glass sam-glass-rim rounded-[var(--sam-radius-pane)] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden';
  // The chat surfaces scroll inside their own panes, so their main does not clip: clipping it
  // would cut the panes' shadows off at its edges. Ordinary pages scroll in main itself.
  const mainClassName = `sam-main-content relative flex min-h-0 min-w-0 flex-1 flex-col ${
    bareMain ? 'overflow-visible' : 'overflow-x-hidden overflow-y-auto'
  }`;

  const signOutHandler = () => {
    void handleSignOut();
  };

  if (isMobile) {
    return (
      <AppShellContext.Provider value={shellContext}>
        <ChatImmersiveContext.Provider value={chatImmersiveContext}>
          <OnboardingProvider>
            <ChoosePathWizard />
            <div
              className={`sam-void flex h-screen flex-col gap-2.5 ${chatImmersive ? 'p-1.5' : 'p-2.5'}`}
              data-chat-immersive={chatImmersive ? 'on' : undefined}
            >
              <SkipToContent />
              <MobileAppBar
                projectName={projectId ? projectName || 'Project' : undefined}
                onOpenMenu={() => setDrawerOpen(true)}
                screenAction={screenAction}
              />

              <div key="main-frame" className={mainFrameClassName}>
                <main id="main-content" className={mainClassName}>
                  {children ?? <Outlet />}
                </main>
              </div>

              {/* Hidden while nothing plays, so an empty slot does not add a gap below the panes. */}
              <div key="global-audio" className="shrink-0 empty:hidden">
                <GlobalAudioPlayer />
              </div>

              {drawerOpen && user && (
                <MobileNavDrawer
                  onClose={() => setDrawerOpen(false)}
                  user={{ name: user.name, email: user.email, image: user.image }}
                  navItems={mobileNavItems}
                  globalNavItems={projectId ? mobileGlobalNavItems : undefined}
                  currentPath={location.pathname}
                  onNavigate={(path) => {
                    navigate(path);
                    setDrawerOpen(false);
                  }}
                  onSignOut={handleSignOut}
                  onOpenSearch={() => {
                    setDrawerOpen(false);
                    commandPalette.open();
                  }}
                  projectName={projectId ? projectName || 'Project' : undefined}
                  projectListSection={mobileProjectListSection}
                  projectHealthElement={mobileProjectHealthElement}
                  showGlobalNav={showGlobalNav}
                  onToggleGlobalNav={projectId ? handleToggleGlobalNav : undefined}
                />
              )}

              {commandPalette.isOpen && <GlobalCommandPalette onClose={commandPalette.close} />}
            </div>
          </OnboardingProvider>
        </ChatImmersiveContext.Provider>
      </AppShellContext.Provider>
    );
  }

  const navWidth = navWidthForMode(focusMode);

  return (
    <AppShellContext.Provider value={shellContext}>
      <OnboardingProvider>
        <ChoosePathWizard />
        <div
          className="sam-void grid h-screen overflow-hidden p-4 transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"
          style={{
            gridTemplateColumns: `${navWidth}px minmax(0, 1fr)`,
            gridTemplateRows: 'minmax(0, 1fr) auto',
            // Zen collapses the nav column to nothing, so it must not keep a gutter either.
            columnGap: navWidth > 0 ? 'var(--sam-space-gutter)' : 0,
            ['--sam-void-x' as string]: '58%',
          }}
        >
          <SkipToContent />
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
            /* `overflow-y-auto` is a backstop, not the primary scroller — NavSidebar scrolls
               itself (it carries `flex-1 min-h-0`). It only engages on very short windows,
               where the header, search, layout control and footer no longer fit, so sign-out
               stays reachable. */
            <aside
              aria-label="Sidebar"
              className="sam-glass sam-glass-rim relative z-30 flex min-h-0 flex-col overflow-x-hidden overflow-y-auto rounded-[var(--sam-radius-pane)]"
              style={{ gridRow: '1' }}
            >
              <DesktopSidebar
                focusMode={focusMode}
                onSelectFocusMode={setFocusMode}
                onCycleFocusMode={cycleFocusMode}
                onOpenCommandPalette={commandPalette.open}
                projectName={projectName}
                showGlobalNav={showGlobalNav}
                onToggleGlobalNav={handleToggleGlobalNav}
                projectListSection={desktopProjectListSection}
                projectHealthElement={projectHealthElement}
                user={user ?? null}
                onSignOut={signOutHandler}
              />
            </aside>
          )}

          <div key="main-frame" className={mainFrameClassName} style={{ gridRow: '1' }}>
            <main id="main-content" className={mainClassName} style={{ gridRow: '1' }}>
              {children ?? <Outlet />}
            </main>
          </div>

          <div key="global-audio" style={{ gridColumn: '1 / -1', gridRow: '2' }}>
            <GlobalAudioPlayer />
          </div>

          {commandPalette.isOpen && <GlobalCommandPalette onClose={commandPalette.close} />}
        </div>
      </OnboardingProvider>
    </AppShellContext.Provider>
  );
}
