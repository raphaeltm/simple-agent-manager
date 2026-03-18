import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  Home,
  FolderKanban,
  Settings,
  Shield,
  Server,
  Monitor,
  MessageSquare,
  ClipboardList,
  LayoutDashboard,
  Activity,
  Radio,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from './AuthProvider';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

/** Global nav items shown when NOT inside a project */
export const GLOBAL_NAV_ITEMS: NavItem[] = [
  { label: 'Home', path: '/dashboard', icon: <Home size={18} /> },
  { label: 'Projects', path: '/projects', icon: <FolderKanban size={18} /> },
  { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
];

/** Project sub-nav items — paths are relative to /projects/:id/ */
export const PROJECT_NAV_ITEMS: NavItem[] = [
  { label: 'Chat', path: 'chat', icon: <MessageSquare size={18} /> },
  { label: 'Tasks', path: 'tasks', icon: <ClipboardList size={18} /> },
  { label: 'Overview', path: 'overview', icon: <LayoutDashboard size={18} /> },
  { label: 'Activity', path: 'activity', icon: <Activity size={18} /> },
  { label: 'Sessions', path: 'sessions', icon: <Radio size={18} /> },
  { label: 'Settings', path: 'settings', icon: <Settings size={18} /> },
];

function isActive(itemPath: string, pathname: string): boolean {
  if (itemPath === '/dashboard') return pathname === '/dashboard';
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

function isProjectSubActive(subPath: string, projectId: string, pathname: string): boolean {
  const fullPath = `/projects/${projectId}/${subPath}`;
  return pathname === fullPath || pathname.startsWith(`${fullPath}/`);
}

interface NavSidebarProps {
  className?: string;
  projectName?: string;
}

export function NavSidebar({ className, projectName }: NavSidebarProps) {
  const location = useLocation();
  const { id: projectId } = useParams<{ id: string }>();
  const { isSuperadmin } = useAuth();
  const [infraOpen, setInfraOpen] = useState(false);

  const insideProject = Boolean(projectId) && location.pathname.startsWith(`/projects/${projectId}`);

  // ── Project-scoped sidebar ──
  if (insideProject && projectId) {
    return (
      <nav aria-label="Project navigation" className={`flex flex-col gap-1 p-2 ${className ?? ''}`}>
        {/* Back to Projects */}
        <Link
          to="/projects"
          className="flex items-center gap-2 px-3 py-2 rounded-sm no-underline text-sm text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-all duration-150"
        >
          <ArrowLeft size={16} />
          <span>Back to Projects</span>
        </Link>

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
              className={`flex items-center gap-3 px-3 py-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${
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
    );
  }

  // ── Global sidebar ──
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
            className={`flex items-center gap-3 px-3 py-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${
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
            className="flex items-center gap-2 w-full px-3 py-2 rounded-sm bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-150"
            aria-expanded={infraOpen}
          >
            {infraOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Infrastructure
          </button>
          {infraOpen && (
            <div className="flex flex-col gap-1">
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
                    className={`flex items-center gap-3 px-3 py-2 ml-2 rounded-sm no-underline text-sm font-medium transition-all duration-150 ${
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
