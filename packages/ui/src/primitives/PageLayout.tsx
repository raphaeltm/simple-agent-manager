import type { CSSProperties, ReactNode } from 'react';

interface PageLayoutProps {
  /** Page title — currently unused visually but kept for semantic context. */
  title?: string;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
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
const mainPaddingStyle: CSSProperties = {
  padding: 'var(--sam-space-8) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))',
};
const compactPaddingStyle: CSSProperties = {
  padding: 'var(--sam-space-3) var(--sam-space-3)',
};

export function PageLayout({
  title,
  children,
  maxWidth = 'lg',
  compact = false,
}: PageLayoutProps) {
  const mwClass = maxWidthClasses[maxWidth];

  // The app shell's content pane is the page surface (frosted glass), so the page paints no
  // background of its own and fills the pane rather than one screen height: a screen-tall
  // opaque canvas ended partway down a long page and showed as a seam once scrolled.
  return (
    <div className={`w-full min-w-0 flex-1 ${compact ? 'flex flex-col' : ''}`}>
      <main
        className={`${mwClass} mx-auto ${compact ? 'flex flex-col flex-1 min-h-0' : ''}`}
        style={compact ? compactPaddingStyle : mainPaddingStyle}
      >
        {title && <h1 className="sr-only">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
