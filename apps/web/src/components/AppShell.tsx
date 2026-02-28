import { useState, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
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

const shellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '220px 1fr',
  minHeight: 'var(--sam-app-height, 100vh)',
  backgroundColor: 'var(--sam-color-bg-canvas)',
};

const shellMobileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 'var(--sam-app-height, 100vh)',
  backgroundColor: 'var(--sam-color-bg-canvas)',
};

const sidebarStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid var(--sam-color-border-default)',
  backgroundColor: 'var(--sam-color-bg-surface)',
  position: 'sticky',
  top: 0,
  height: '100vh',
  overflowY: 'auto',
};

const logoStyle: CSSProperties = {
  padding: 'var(--sam-space-4)',
  fontSize: 'var(--sam-type-card-title-size)',
  fontWeight: 'var(--sam-type-card-title-weight)',
  color: 'var(--sam-color-fg-primary)',
  borderBottom: '1px solid var(--sam-color-border-default)',
};

const userSectionStyle: CSSProperties = {
  marginTop: 'auto',
  padding: 'var(--sam-space-3)',
  borderTop: '1px solid var(--sam-color-border-default)',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sam-space-2)',
};

const mobileHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: 'var(--sam-space-2) var(--sam-space-4)',
  borderBottom: '1px solid var(--sam-color-border-default)',
  backgroundColor: 'var(--sam-color-bg-surface)',
};

const contentStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

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
      style={{ height: 28, width: 28, borderRadius: '50%' }}
    />
  ) : (
    <div style={{
      height: 28,
      width: 28,
      borderRadius: '50%',
      backgroundColor: 'var(--sam-color-accent-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--sam-color-fg-on-accent)',
      fontSize: 'var(--sam-type-caption-size)',
      fontWeight: 500,
    }}>
      {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
    </div>
  );

  if (isMobile) {
    return (
      <div style={shellMobileStyle}>
        <header style={mobileHeaderStyle}>
          {/* Title on the left */}
          <span style={{ fontSize: 'var(--sam-type-card-title-size)', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>
            SAM
          </span>
          {/* Hamburger on the right — matches drawer slide-in direction */}
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              background: 'none',
              border: 'none',
              color: 'var(--sam-color-fg-muted)',
              cursor: 'pointer',
            }}
          >
            <Menu size={20} />
          </button>
        </header>

        <main style={contentStyle}>
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
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <div style={logoStyle}>SAM</div>
        <NavSidebar />
        {user && (
          <div style={userSectionStyle}>
            {avatarElement}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 'var(--sam-type-caption-size)',
                fontWeight: 500,
                color: 'var(--sam-color-fg-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {user.name || user.email}
              </div>
            </div>
            <button
              onClick={handleSignOut}
              aria-label="Sign out"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--sam-color-fg-muted)',
                cursor: 'pointer',
                padding: 'var(--sam-space-1)',
                fontSize: 'var(--sam-type-caption-size)',
              }}
              className="sam-signout-btn"
            >
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        )}
      </aside>

      <main style={contentStyle}>
        {children ?? <Outlet />}
      </main>

      <style>{`
        .sam-signout-btn:hover {
          color: var(--sam-color-danger);
        }
      `}</style>
    </div>
  );
}
