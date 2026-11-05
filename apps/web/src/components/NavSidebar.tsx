import { NavItem as GlassNavItem, NavLabel } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Brain,
  FileCode,
  FolderKanban,
  FolderOpen,
  Home,
  Lightbulb,
  Map,
  MessageSquare,
  MessageSquareQuote,
  PlayCircle,
  Rocket,
  Server,
  Settings,
  Shield,
  UserCog,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import { useSamSettings } from '../hooks/useSamSettings';
import { useAuth } from './AuthProvider';
import { useOnboarding } from './onboarding';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

/** Global nav items shown when NOT inside a project */
export const GLOBAL_NAV_ITEMS: NavItem[] = [
  { label: 'Home', path: '/dashboard', icon: <Home size={18} /> },
  { label: 'Chats', path: '/chats', icon: <MessageSquare size={18} /> },
  { label: 'Projects', path: '/projects', icon: <FolderKanban size={18} /> },
  { label: 'Map', path: '/account-map', icon: <Map size={18} /> },
  { label: 'Tools', path: '/tools', icon: <Wrench size={18} /> },
  // Opens the Nodes page; labelled for the whole area.
  { label: 'Infrastructure', path: '/nodes', icon: <Server size={18} /> },
  { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
];

export function getGlobalNavItems(samEnabled: boolean): NavItem[] {
  return samEnabled
    ? [
        ...GLOBAL_NAV_ITEMS.slice(0, 1),
        { label: 'SAM', path: '/sam', icon: <Bot size={18} /> },
        ...GLOBAL_NAV_ITEMS.slice(1),
      ]
    : GLOBAL_NAV_ITEMS;
}

/** Project sub-nav items — paths are relative to /projects/:id/ */
export const PROJECT_NAV_ITEMS: NavItem[] = [
  { label: 'Chat', path: 'chat', icon: <MessageSquare size={18} /> },
  // { label: 'Agent', path: 'agent', icon: <Bot size={18} /> }, // Hidden — experimental, not ready for users yet
  // MessageSquareQuote, not MessageSquare: Chat already owns the plain speech
  // bubble, and two bubbles side by side in the same rail are indistinguishable
  // at 18px. The quote marks are what make this read as "annotation".
  { label: 'Comments', path: 'comments', icon: <MessageSquareQuote size={18} /> },
  { label: 'Files', path: 'files', icon: <FileCode size={18} /> },
  { label: 'Library', path: 'library', icon: <FolderOpen size={18} /> },
  { label: 'Ideas', path: 'ideas', icon: <Lightbulb size={18} /> },
  { label: 'Deployments', path: 'deployments', icon: <Rocket size={18} /> },
  { label: 'Agent Context', path: 'agent-context', icon: <Brain size={18} /> },
  { label: 'Notifications', path: 'notifications', icon: <Bell size={18} /> },
  // One item for everything that starts work on its own (it replaced Events and Triggers).
  { label: 'Automation', path: 'automation', icon: <Workflow size={18} /> },
  { label: 'Profiles', path: 'profiles', icon: <UserCog size={18} /> },
  { label: 'Skills', path: 'skills', icon: <Zap size={18} /> },
  { label: 'Settings', path: 'settings', icon: <Settings size={18} /> },
];

/** Reserved path segments under /projects/ that are NOT project IDs */
const RESERVED_PROJECT_PATHS = new Set(['new']);

/** Extract a real project ID from the current URL, excluding reserved paths */
export function extractProjectId(pathname: string): string | undefined {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  const id = match?.[1];
  if (!id) return undefined;
  return RESERVED_PROJECT_PATHS.has(id) ? undefined : id;
}

function isActive(itemPath: string, pathname: string): boolean {
  if (itemPath === '/dashboard') return pathname === '/dashboard';
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

function isProjectSubActive(subPath: string, projectId: string, pathname: string): boolean {
  const fullPath = `/projects/${projectId}/${subPath}`;
  return pathname === fullPath || pathname.startsWith(`${fullPath}/`);
}

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const TOGGLE_CLASS = `flex h-10 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[11px] border-none bg-transparent text-[14.5px] text-fg-muted transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary ${FOCUS_RING}`;
const SECTION_DIVIDER = 'mt-2 border-t border-[var(--sam-hairline)] pt-2';

interface NavSidebarProps {
  className?: string;
  projectName?: string;
  showGlobalNav?: boolean;
  onToggleGlobalNav?: () => void;
  /** Rendered below the global nav items */
  projectListSection?: ReactNode;
  projectHealthElement?: ReactNode;
  /** Collapse to a 56px icon rail (Focus Mode) — hides labels, centers icons */
  iconOnly?: boolean;
}

export function NavSidebar({
  className,
  projectName,
  showGlobalNav,
  onToggleGlobalNav,
  projectListSection,
  projectHealthElement,
  iconOnly,
}: NavSidebarProps) {
  const sam = useSamSettings();
  const visibleGlobalItems = getGlobalNavItems(sam.enabled);
  const location = useLocation();
  const { isSuperadmin } = useAuth();
  const { needsOnboarding, openOnboarding } = useOnboarding();

  const projectId = extractProjectId(location.pathname);
  const insideProject = Boolean(projectId);
  const projectToggleRef = useRef<HTMLButtonElement>(null);
  const globalToggleRef = useRef<HTMLButtonElement>(null);
  const restoreToggleFocus = useRef(false);

  useLayoutEffect(() => {
    if (!restoreToggleFocus.current) return;
    restoreToggleFocus.current = false;
    (showGlobalNav ? globalToggleRef : projectToggleRef).current?.focus();
  }, [showGlobalNav]);

  const toggleNavigation = () => {
    restoreToggleFocus.current = true;
    onToggleGlobalNav?.();
  };

  const renderItem = (item: NavItem, to: string, active: boolean) => (
    <GlassNavItem
      key={item.path}
      to={to}
      label={item.label}
      icon={item.icon}
      current={active}
      iconOnly={iconOnly}
    />
  );

  // Onboarding resume — shown in both nav layouts when setup is incomplete.
  const onboardingResume = needsOnboarding && (
    <div className={SECTION_DIVIDER}>
      <GlassNavItem
        onClick={openOnboarding}
        label="Complete Setup"
        icon={<PlayCircle size={18} className="text-[var(--sam-status-success-fg)]" />}
        iconOnly={iconOnly}
        className="text-[var(--sam-status-success-fg)]"
      />
    </div>
  );

  // When inside a project, we can toggle between project nav and global nav
  if (insideProject && projectId) {
    const globalItems = isSuperadmin
      ? [...visibleGlobalItems, { label: 'Admin', path: '/admin', icon: <Shield size={18} /> }]
      : visibleGlobalItems;

    return (
      /* `data-intentional-clip`: this is a two-panel carousel — both panels sit
         side by side (2x width) and are translated into view, so its content is
         deliberately wider than its box. Marks it as intentional for the
         `assertNoClippedOverflow` audit guard.

         `flex-1 min-h-0`: `overflow: hidden` resolves this flex item's automatic
         minimum size to 0, so without `flex-1` it collapses to the leftover space
         and silently clips the bottom nav items — with no scrollbar, because the
         `aside` then never overflows either. Claiming the leftover space and
         letting each panel scroll (below) is what makes them reachable. */
      <div
        data-intentional-clip
        className={`relative flex-1 min-h-0 overflow-hidden ${className ?? ''}`}
      >
        {/* Sliding container — holds both panels side by side */}
        <div
          className="flex h-full transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: showGlobalNav ? 'translateX(-100%)' : 'translateX(0)' }}
        >
          {/* Panel 1: Project nav */}
          <nav
            aria-label="Project navigation"
            className="flex h-full w-full shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-2"
            aria-hidden={showGlobalNav || undefined}
            inert={showGlobalNav ? true : undefined}
          >
            {/* Toggle to global nav */}
            <button
              ref={projectToggleRef}
              onClick={toggleNavigation}
              className={`${TOGGLE_CLASS} ${iconOnly ? 'justify-center px-0' : 'px-3'}`}
              aria-label="Show global navigation"
              title={iconOnly ? 'Back to Projects' : undefined}
            >
              <ArrowLeft size={16} />
              {!iconOnly && <span>Back to Projects</span>}
            </button>

            {/* Project name header */}
            {!iconOnly && (
              <NavLabel>
                <span title={projectName}>{projectName || 'Project'}</span>
              </NavLabel>
            )}

            {projectHealthElement && <div className="px-1 pb-1">{projectHealthElement}</div>}

            {/* Project sub-nav */}
            {PROJECT_NAV_ITEMS.map((item) =>
              renderItem(
                item,
                `/projects/${projectId}/${item.path}`,
                isProjectSubActive(item.path, projectId, location.pathname)
              )
            )}
          </nav>

          {/* Panel 2: Global nav (shown when toggled) */}
          <nav
            aria-label="Primary navigation"
            className="flex h-full w-full shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-2"
            aria-hidden={!showGlobalNav || undefined}
            inert={!showGlobalNav ? true : undefined}
          >
            {/* Toggle back to project nav */}
            <button
              ref={globalToggleRef}
              onClick={toggleNavigation}
              className={`${TOGGLE_CLASS} ${iconOnly ? 'justify-center px-0' : 'px-3'}`}
              aria-label={`Back to ${projectName || 'project'} navigation`}
              title={iconOnly ? `Back to ${projectName || 'Project'}` : undefined}
            >
              <ArrowRight size={16} />
              {!iconOnly && <span className="truncate">Back to {projectName || 'Project'}</span>}
            </button>

            {/* Global nav items */}
            {globalItems.map((item) =>
              renderItem(item, item.path, isActive(item.path, location.pathname))
            )}

            {onboardingResume}

            {/* Project list — hidden in the Focus rail (too wide for 56px) */}
            {!iconOnly && projectListSection}
          </nav>
        </div>
      </div>
    );
  }

  // ── Global sidebar (when not inside a project) ──
  const globalItems = isSuperadmin
    ? [...visibleGlobalItems, { label: 'Admin', path: '/admin', icon: <Shield size={18} /> }]
    : visibleGlobalItems;

  return (
    // `flex-1 min-h-0 overflow-y-auto`: same reason as the project carousel above
    // — the list must own the leftover column space and scroll itself, so the
    // `aside`'s header and user footer stay pinned on short viewports.
    <nav
      aria-label="Primary navigation"
      className={`flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2 ${className ?? ''}`}
    >
      {globalItems.map((item) =>
        renderItem(item, item.path, isActive(item.path, location.pathname))
      )}

      {onboardingResume}

      {/* Project list — hidden in the Focus rail (too wide for 56px) */}
      {!iconOnly && projectListSection}
    </nav>
  );
}
