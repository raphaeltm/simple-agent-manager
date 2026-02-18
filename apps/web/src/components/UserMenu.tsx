import { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { signOut } from '../lib/auth';

const PRIMARY_NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard' },
  { label: 'Projects', path: '/projects' },
  { label: 'Nodes', path: '/nodes' },
  { label: 'Settings', path: '/settings' },
];

function isNavItemActive(path: string, pathname: string): boolean {
  if (path === '/dashboard') {
    return pathname === '/dashboard';
  }

  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * User menu with avatar and dropdown.
 */
export function UserMenu() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  if (!user) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
      <style>{`
        .sam-user-name { display: none; }
        .sam-primary-nav {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          overflow-x: auto;
          max-width: min(52vw, 36rem);
          padding-bottom: 2px;
        }
        .sam-primary-nav-link {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.4rem 0.625rem;
          border-radius: var(--sam-radius-md);
          border: 1px solid transparent;
          font-size: 0.8125rem;
          font-weight: 500;
          text-decoration: none;
          color: var(--sam-color-fg-muted);
          white-space: nowrap;
          transition: all 0.12s ease;
        }
        .sam-primary-nav-link:hover {
          color: var(--sam-color-fg-primary);
          background: color-mix(in srgb, var(--sam-color-bg-surface) 72%, transparent);
          border-color: var(--sam-color-border-default);
        }
        .sam-primary-nav-link.is-active {
          color: var(--sam-color-fg-primary);
          background: color-mix(in srgb, var(--sam-color-accent-primary) 16%, transparent);
          border-color: color-mix(in srgb, var(--sam-color-accent-primary) 55%, var(--sam-color-border-default));
        }
        @media (min-width: 640px) {
          .sam-user-name { display: inline-block; }
        }
      `}</style>

      <nav className="sam-primary-nav" aria-label="Primary navigation">
        {PRIMARY_NAV_ITEMS.map((item) => (
          <Link
            key={item.path}
            className={`sam-primary-nav-link${isNavItemActive(item.path, location.pathname) ? ' is-active' : ''}`}
            to={item.path}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div style={{ position: 'relative' }} ref={menuRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: 'var(--sam-color-fg-muted)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
          }}
        >
          {user.image ? (
            <img
              src={user.image}
              alt={user.name || user.email}
              style={{ height: 32, width: 32, borderRadius: '50%' }}
            />
          ) : (
            <div style={{
              height: 32,
              width: 32,
              borderRadius: '50%',
              backgroundColor: 'var(--sam-color-accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}>
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <span className="sam-user-name" style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>
            {user.name || user.email}
          </span>
          <svg
            style={{ height: 16, width: 16, transition: 'transform 0.15s', transform: isOpen ? 'rotate(180deg)' : 'none' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isOpen && (
          <div style={{
            position: 'absolute',
            right: 0,
            marginTop: '0.5rem',
            width: '12rem',
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 'var(--sam-radius-md)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            border: '1px solid var(--sam-color-border-default)',
            zIndex: 10,
            overflow: 'hidden',
          }}>
            <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--sam-color-border-default)' }}>
              <p style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.name || 'User'}
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
            </div>

            {PRIMARY_NAV_ITEMS.map((item) => (
              <button
                key={item.path}
                onClick={() => { setIsOpen(false); navigate(item.path); }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  color: 'var(--sam-color-fg-primary)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--sam-color-bg-surface-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                {item.label}
              </button>
            ))}

            <hr style={{ border: 'none', borderTop: '1px solid var(--sam-color-border-default)', margin: '0.25rem 0' }} />

            <button
              onClick={handleSignOut}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 1rem',
                fontSize: '0.875rem',
                color: 'var(--sam-color-danger)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--sam-color-bg-surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
