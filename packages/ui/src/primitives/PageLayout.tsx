import type { CSSProperties, ReactNode } from 'react';

interface PageLayoutProps {
  title: string;
  children: ReactNode;
  backTo?: string;
  onBack?: () => void;
  headerRight?: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

const maxWidthMap = {
  sm: '40rem',
  md: '56rem',
  lg: '72rem',
  xl: '80rem',
};

export function PageLayout({
  title,
  children,
  backTo,
  onBack,
  headerRight,
  maxWidth = 'lg',
}: PageLayoutProps) {
  const headerStyle: CSSProperties = {
    backgroundColor: 'var(--sam-color-bg-surface)',
    borderBottom: '1px solid var(--sam-color-border-default)',
  };

  const headerInnerStyle: CSSProperties = {
    maxWidth: maxWidthMap[maxWidth],
    margin: '0 auto',
    padding: 'var(--sam-space-4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const titleGroupStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-4)',
  };

  const backButtonStyle: CSSProperties = {
    background: 'none',
    border: 'none',
    color: 'var(--sam-color-fg-muted)',
    cursor: 'pointer',
    padding: 'var(--sam-space-1)',
    display: 'flex',
    alignItems: 'center',
  };

  const titleStyle: CSSProperties = {
    fontSize: 'clamp(1.125rem, 2vw, 1.375rem)',
    fontWeight: 600,
    color: 'var(--sam-color-fg-primary)',
    margin: 0,
  };

  const mainStyle: CSSProperties = {
    maxWidth: maxWidthMap[maxWidth],
    margin: '0 auto',
    padding: 'var(--sam-space-8) var(--sam-space-4)',
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (backTo) {
      window.location.href = backTo;
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sam-color-bg-canvas)' }}>
      <header style={headerStyle}>
        <div style={headerInnerStyle}>
          <div style={titleGroupStyle}>
            {(backTo || onBack) && (
              <button onClick={handleBack} style={backButtonStyle} aria-label="Go back">
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <h1 style={titleStyle}>{title}</h1>
          </div>
          {headerRight && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-4)' }}>{headerRight}</div>}
        </div>
      </header>
      <main style={mainStyle}>{children}</main>
    </div>
  );
}
