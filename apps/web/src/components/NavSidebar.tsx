import { Link, useLocation } from 'react-router-dom';
import { Home, FolderKanban, Server, Monitor, Settings, Shield } from 'lucide-react';
import { useAuth } from './AuthProvider';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: <Home size={18} /> },
  { label: 'Projects', path: '/projects', icon: <FolderKanban size={18} /> },
  { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
  { label: 'Workspaces', path: '/workspaces', icon: <Monitor size={18} /> },
  { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
];

function isActive(itemPath: string, pathname: string): boolean {
  if (itemPath === '/dashboard') return pathname === '/dashboard';
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

interface NavSidebarProps {
  className?: string;
}

export function NavSidebar({ className }: NavSidebarProps) {
  const location = useLocation();
  const { isSuperadmin } = useAuth();

  const items = isSuperadmin
    ? [...NAV_ITEMS, { label: 'Admin', path: '/admin', icon: <Shield size={18} /> }]
    : NAV_ITEMS;

  return (
    <nav aria-label="Primary navigation" className={`flex flex-col gap-1 p-2 ${className ?? ''}`}>
      {items.map((item) => {
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
    </nav>
  );
}
