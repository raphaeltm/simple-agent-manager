import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Home,
  Lightbulb,
  Map,
  MessageSquare,
  Monitor,
  Server,
  Settings,
  Shield,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';

import { useAuth } from './AuthProvider';

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
  { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
];

/** Project sub-nav items — paths are relative to /projects/:id/ */
export const PROJECT_NAV_ITEMS: NavItem[] = [
  { label: 'Chat', path: 'chat', icon: <MessageSquare size={18} /> },
  { label: 'Ideas', path: 'ideas', icon: <Lightbulb size={18} /> },
  { label: 'Activity', path: 'activity', icon: <Activity size={18} /> },
  { label: 'Notifications', path: 'notifications', icon: <Bell size={18} /> },
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

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

interface NavSidebarProps {
  className?: string;
  projectName?: string;
  showGlobalNav?: boolean;
  onToggleGlobalNav?: () => void;
}

export function NavSidebar({ className, projectName, showGlobalNav, onToggleGlobalNav }: NavSidebarProps) {
  const location = useLocation();
  const { isSuperadmin } = useAuth();
  const [infraOpen, setInfraOpen] = useState(false);

  const projectId = extractProjectId(location.pathname);
  const insideProject = Boolean(projectId);

  // When inside a project, we can toggle between project nav and global nav
  if (insideProject && projectId) {
    const globalItems = isSuperadmin
      ? [...GLOBAL_NAV_ITEMS, { label: 'Admin', path: '/admin', icon: <Shield size={18} /> }]
      : GLOBAL_NAV_ITEMS;

    return (
      <div className={`relative overflow-hidden ${className ?? ''}`}>
        {/* Sliding container — holds both panels side by side */}
        <div
          className="flex transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: showGlobalNav ? 'translateX(-50%)' : 'translateX(0)' }}
        >
          {/* Panel 1: Project nav */}
          <nav
            aria-label="Project navigation"
            className="flex flex-col gap-1 p-2 w-full shrink-0"
            aria-hidden={showGlobalNav || undefined}
            inert={showGlobalNav ? true : undefined}
          >
            {/* Toggle to global nav */}
            <button
              onClick={onToggleGlobalNav}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-sm bg-transparent border-none text-sm text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer transition-all duration-150 ${FOCUS_RING}`}
              aria-label="Show global navigation"
            >
              <ArrowLeft size={16} />
              <span>Back to Projects</span>
            </button>

            {/* Project name header */}
            <div className="px-3 py-2 text-xs font-semibold text-fg-muted uppercase tracking-wider truncate" title={projectName}>
              {projectName || 'Project'}
            </div>

            {/* Project sub-nav */}
            {PROJECT_NAV_ITEMS.map((item) => {
              const active = isProjectSubActive(item.path, projectId, location.pathname);
              return (
                <Link
                  key={item.path}
                  to={`/projects/${projectId}/${item.path}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 px-3 py-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${FOCUS_RING} ${
                    active
                      ? 'text-accent bg-surface-hover'
                      : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Panel 2: Global nav (shown when toggled) */}
          <nav
            aria-label="Primary navigation"
            className="flex flex-col gap-1 p-2 w-full shrink-0"
            aria-hidden={!showGlobalNav || undefined}
            inert={!showGlobalNav ? true : undefined}
          >
            {/* Toggle back to project nav */}
            <button
              onClick={onToggleGlobalNav}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-sm bg-transparent border-none text-sm text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer transition-all duration-150 ${FOCUS_RING}`}
              aria-label={`Back to ${projectName || 'project'} navigation`}
            >
              <ArrowRight size={16} />
              <span className="truncate">Back to {projectName || 'Project'}</span>
            </button>

            {/* Global nav items */}
            {globalItems.map((item) => {
              const active = isActive(item.path, location.pathname);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 px-3 py-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${FOCUS_RING} ${
                    active
                      ? 'text-accent bg-surface-hover'
                      : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}

            {/* Infrastructure section — superadmin only */}
            {isSuperadmin && (
              <div className="mt-2">
                <button
                  onClick={() => setInfraOpen(!infraOpen)}
                  className={`flex items-center gap-2 w-full px-3 py-2 rounded-sm bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-150 ${FOCUS_RING}`}
                  aria-expanded={infraOpen}
                  aria-controls="infra-nav-panel"
                >
                  {infraOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Infrastructure
                </button>
                {infraOpen && (
                  <div id="infra-nav-panel" className="flex flex-col gap-1">
                    {[
                      { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
                      { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
                    ].map((item) => {
                      const active = isActive(item.path, location.pathname);
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-3 px-3 py-2 ml-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${FOCUS_RING} ${
                            active
                              ? 'text-accent bg-surface-hover'
                              : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
                          }`}
                        >
                          {item.icon}
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </nav>
        </div>
      </div>
    );
  }

  // ── Global sidebar (when not inside a project) ──
  const globalItems = isSuperadmin
    ? [...GLOBAL_NAV_ITEMS, { label: 'Admin', path: '/admin', icon: <Shield size={18} /> }]
    : GLOBAL_NAV_ITEMS;

  return (
    <nav aria-label="Primary navigation" className={`flex flex-col gap-1 p-2 ${className ?? ''}`}>
      {globalItems.map((item) => {
        const active = isActive(item.path, location.pathname);
        return (
          <Link
            key={item.path}
            to={item.path}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${FOCUS_RING} ${
              active
                ? 'text-accent bg-surface-hover'
                : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
            }`}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}

      {/* Infrastructure section — superadmin only */}
      {isSuperadmin && (
        <div className="mt-2">
          <button
            onClick={() => setInfraOpen(!infraOpen)}
            className={`flex items-center gap-2 w-full px-3 py-2 rounded-sm bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-150 ${FOCUS_RING}`}
            aria-expanded={infraOpen}
            aria-controls="infra-nav-panel"
          >
            {infraOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Infrastructure
          </button>
          {infraOpen && (
            <div id="infra-nav-panel" className="flex flex-col gap-1">
              {[
                { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
                { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
              ].map((item) => {
                const active = isActive(item.path, location.pathname);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-3 px-3 py-2 ml-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${FOCUS_RING} ${
                      active
                        ? 'text-accent bg-surface-hover'
                        : 'text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
