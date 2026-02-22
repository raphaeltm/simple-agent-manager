import type { CSSProperties, ReactNode } from 'react';

type TypographyVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'body-muted'
  | 'caption';

export interface TypographyProps {
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
  children: ReactNode;
  variant?: TypographyVariant;
  className?: string;
  style?: CSSProperties;
}

const variantStyles: Record<TypographyVariant, CSSProperties> = {
  display: {
    fontSize: 'clamp(1.75rem, 3vw, 2.75rem)',
    lineHeight: 1.15,
    fontWeight: 700,
    color: 'var(--sam-color-fg-primary)',
  },
  title: {
    fontSize: 'clamp(1.375rem, 2.4vw, 2rem)',
    lineHeight: 1.2,
    fontWeight: 700,
    color: 'var(--sam-color-fg-primary)',
  },
  heading: {
    fontSize: 'clamp(1.125rem, 2vw, 1.375rem)',
    lineHeight: 1.3,
    fontWeight: 600,
    color: 'var(--sam-color-fg-primary)',
  },
  body: {
    fontSize: '1rem',
    lineHeight: 1.5,
    fontWeight: 400,
    color: 'var(--sam-color-fg-primary)',
  },
  'body-muted': {
    fontSize: '1rem',
    lineHeight: 1.5,
    fontWeight: 400,
    color: 'var(--sam-color-fg-muted)',
  },
  caption: {
    fontSize: '0.875rem',
    lineHeight: 1.4,
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
  },
};

export function Typography({
  as = 'p',
  children,
  variant = 'body',
  className = '',
  style,
}: TypographyProps) {
  const Tag = as;
  return (
    <Tag style={{ ...variantStyles[variant], ...style }} className={className}>
      {children}
    </Tag>
  );
}

/* ── Named tier components ──────────────────────────────────
 * Each maps to the 6-tier typography scale from theme.css
 * (--sam-type-page-title-*, --sam-type-section-heading-*, etc.)
 * These use CSS custom properties so they stay in sync with tokens.
 */

interface TierProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const tierStyles = {
  pageTitle: {
    fontSize: 'var(--sam-type-page-title-size)',
    fontWeight: 'var(--sam-type-page-title-weight)',
    lineHeight: 'var(--sam-type-page-title-line-height)',
    color: 'var(--sam-color-fg-primary)',
    margin: 0,
  } as CSSProperties,
  sectionHeading: {
    fontSize: 'var(--sam-type-section-heading-size)',
    fontWeight: 'var(--sam-type-section-heading-weight)',
    lineHeight: 'var(--sam-type-section-heading-line-height)',
    color: 'var(--sam-color-fg-primary)',
    margin: 0,
  } as CSSProperties,
  cardTitle: {
    fontSize: 'var(--sam-type-card-title-size)',
    fontWeight: 'var(--sam-type-card-title-weight)',
    lineHeight: 'var(--sam-type-card-title-line-height)',
    color: 'var(--sam-color-fg-primary)',
    margin: 0,
  } as CSSProperties,
  body: {
    fontSize: 'var(--sam-type-body-size)',
    fontWeight: 'var(--sam-type-body-weight)',
    lineHeight: 'var(--sam-type-body-line-height)',
    color: 'var(--sam-color-fg-primary)',
    margin: 0,
  } as CSSProperties,
  secondary: {
    fontSize: 'var(--sam-type-secondary-size)',
    fontWeight: 'var(--sam-type-secondary-weight)',
    lineHeight: 'var(--sam-type-secondary-line-height)',
    color: 'var(--sam-color-fg-muted)',
    margin: 0,
  } as CSSProperties,
  caption: {
    fontSize: 'var(--sam-type-caption-size)',
    fontWeight: 'var(--sam-type-caption-weight)',
    lineHeight: 'var(--sam-type-caption-line-height)',
    color: 'var(--sam-color-fg-muted)',
    margin: 0,
  } as CSSProperties,
};

export function PageTitle({ children, className, style }: TierProps) {
  return <h1 style={{ ...tierStyles.pageTitle, ...style }} className={className}>{children}</h1>;
}

export function SectionHeading({ children, className, style }: TierProps) {
  return <h2 style={{ ...tierStyles.sectionHeading, ...style }} className={className}>{children}</h2>;
}

export function CardTitle({ children, className, style }: TierProps) {
  return <h3 style={{ ...tierStyles.cardTitle, ...style }} className={className}>{children}</h3>;
}

export function Body({ children, className, style }: TierProps) {
  return <p style={{ ...tierStyles.body, ...style }} className={className}>{children}</p>;
}

export function Secondary({ children, className, style }: TierProps) {
  return <p style={{ ...tierStyles.secondary, ...style }} className={className}>{children}</p>;
}

export function Caption({ children, className, style }: TierProps) {
  return <span style={{ ...tierStyles.caption, ...style }} className={className}>{children}</span>;
}
