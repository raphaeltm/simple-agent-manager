import { type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, FolderKanban, Server, Settings } from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: <Home size={18} /> },
  { label: 'Projects', path: '/projects', icon: <FolderKanban size={18} /> },
  { label: 'Nodes', path: '/nodes', icon: <Server size={18} /> },
  { label: 'Settings', path: '/settings', icon: <Settings size={18} /> },
];

function isActive(itemPath: string, pathname: string): boolean {
  if (itemPath === '/dashboard') return pathname === '/dashboard';
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

interface NavSidebarProps {
  className?: string;
}

const navStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sam-space-1)',
  padding: 'var(--sam-space-2)',
};

export function NavSidebar({ className }: NavSidebarProps) {
  const location = useLocation();

  return (
    <nav aria-label="Primary navigation" className={className} style={navStyle}>
      {NAV_ITEMS.map((item) => {
        const active = isActive(item.path, location.pathname);
        return (
          <Link
            key={item.path}
            to={item.path}
            className={`sam-nav-sidebar-link${active ? ' is-active' : ''}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sam-space-3)',
              padding: 'var(--sam-space-2) var(--sam-space-3)',
              borderRadius: 'var(--sam-radius-sm)',
              textDecoration: 'none',
              fontSize: 'var(--sam-type-secondary-size)',
              fontWeight: 500,
              color: active ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
              background: active ? 'var(--sam-color-bg-surface-hover)' : 'transparent',
              transition: 'all 150ms ease',
            }}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}

      <style>{`
        .sam-nav-sidebar-link:hover:not(.is-active) {
          color: var(--sam-color-fg-primary);
          background: var(--sam-color-bg-surface-hover);
        }
      `}</style>
    </nav>
  );
}
