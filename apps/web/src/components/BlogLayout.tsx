import { type FC } from 'react';
import { Link, Outlet } from 'react-router-dom';

export const BlogLayout: FC = () => {
  return (
    <div
      style={{
        minHeight: 'var(--sam-app-height)',
        backgroundColor: 'var(--sam-color-bg-canvas)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 var(--sam-space-4)',
          height: 56,
          borderBottom: '1px solid var(--sam-color-border-default)',
          backgroundColor: 'var(--sam-color-bg-surface)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
          <Link
            to="/"
            style={{
              textDecoration: 'none',
              color: 'var(--sam-color-fg-primary)',
              fontWeight: 700,
              fontSize: 'var(--sam-type-section-heading-size)',
            }}
          >
            SAM
          </Link>
          <span style={{ color: 'var(--sam-color-border-default)' }}>/</span>
          <Link
            to="/blog"
            style={{
              textDecoration: 'none',
              color: 'var(--sam-color-fg-muted)',
              fontWeight: 500,
              fontSize: 'var(--sam-type-body-size)',
            }}
          >
            Blog
          </Link>
        </div>
        <Link
          to="/"
          style={{
            textDecoration: 'none',
            color: 'var(--sam-color-fg-primary)',
            fontSize: 'var(--sam-type-secondary-size)',
            fontWeight: 500,
            padding: '6px 14px',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
          }}
        >
          Sign In
        </Link>
      </header>

      {/* Content */}
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>

      {/* Footer */}
      <footer
        style={{
          padding: 'var(--sam-space-4)',
          borderTop: '1px solid var(--sam-color-border-default)',
          textAlign: 'center',
          color: 'var(--sam-color-fg-muted)',
          fontSize: 'var(--sam-type-caption-size)',
          flexShrink: 0,
        }}
      >
        Simple Agent Manager &mdash; AI coding environments on your own cloud
      </footer>
    </div>
  );
};
