import type { CSSProperties, ReactNode } from 'react';

interface PageLayoutProps {
  title: string;
  children: ReactNode;
  backTo?: string;
  onBack?: () => void;
  headerRight?: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
  /** When true, the header bar is hidden (useful on mobile where AppShell provides its own header). */
  hideHeader?: boolean;
  /** When true, use compact padding suitable for mobile viewports. */
  compact?: boolean;
}

const maxWidthClasses: Record<NonNullable<PageLayoutProps['maxWidth']>, string> = {
  sm: 'max-w-[40rem]',
  md: 'max-w-[56rem]',
  lg: 'max-w-[72rem]',
  xl: 'max-w-[80rem]',
};

/* clamp() padding values cannot be expressed as static Tailwind classes */
const headerPaddingStyle: CSSProperties = {
  padding: 'var(--sam-space-4) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))',
};
const mainPaddingStyle: CSSProperties = {
  padding: 'var(--sam-space-8) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))',
};
const compactPaddingStyle: CSSProperties = {
  padding: 'var(--sam-space-3) var(--sam-space-3)',
};

export function PageLayout({
  title,
  children,
  backTo,
  onBack,
  headerRight,
  maxWidth = 'lg',
  hideHeader = false,
  compact = false,
}: PageLayoutProps) {
  const mwClass = maxWidthClasses[maxWidth];

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (backTo) {
      window.location.href = backTo;
    }
  };

  return (
    <div className={`min-h-screen bg-canvas ${compact ? 'flex flex-col' : ''}`}>
      {!hideHeader && (
        <header className="hidden md:block bg-surface border-b border-border-default">
          <div
            className={`${mwClass} mx-auto flex items-center justify-between`}
            style={headerPaddingStyle}
          >
            <div className="flex items-center gap-4">
              {(backTo || onBack) && (
                <button
                  onClick={handleBack}
                  className="bg-transparent border-none text-fg-muted cursor-pointer p-1 flex items-center"
                  aria-label="Go back"
                >
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              <h1 className="font-semibold text-fg-primary m-0" style={{ fontSize: 'clamp(1.125rem, 2vw, 1.375rem)', lineHeight: 1.3 }}>
                {title}
              </h1>
            </div>
            {headerRight && <div className="flex items-center gap-4">{headerRight}</div>}
          </div>
        </header>
      )}
      <main
        className={`${mwClass} mx-auto ${compact ? 'flex flex-col flex-1 min-h-0' : ''}`}
        style={compact ? compactPaddingStyle : mainPaddingStyle}
      >
        {children}
      </main>
    </div>
  );
}
