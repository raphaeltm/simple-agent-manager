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

const variantClasses: Record<TypographyVariant, string> = {
  display: 'font-bold text-fg-primary leading-[1.15]',
  title: 'font-bold text-fg-primary leading-[1.2]',
  heading: 'font-semibold text-fg-primary leading-[1.3]',
  body: 'font-normal text-fg-primary text-base leading-[1.5]',
  'body-muted': 'font-normal text-fg-muted text-base leading-[1.5]',
  caption: 'font-medium text-fg-muted text-sm leading-[1.4]',
};

/* clamp() font sizes cannot be expressed as static Tailwind classes */
const variantFontSize: Record<TypographyVariant, string> = {
  display: 'clamp(1.75rem, 3vw, 2.75rem)',
  title: 'clamp(1.375rem, 2.4vw, 2rem)',
  heading: 'clamp(1.125rem, 2vw, 1.375rem)',
  body: '1rem',
  'body-muted': '1rem',
  caption: '0.875rem',
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
    <Tag
      className={`${variantClasses[variant]} ${className}`}
      style={{ fontSize: variantFontSize[variant], ...style }}
    >
      {children}
    </Tag>
  );
}

/* ── Named tier components ──────────────────────────────────
 * Each maps to the 6-tier typography scale from theme.css
 * (--sam-type-page-title-*, --sam-type-section-heading-*, etc.)
 * These use the existing sam-type-* utility classes from theme.css.
 */

interface TierProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function PageTitle({ children, className = '', style }: TierProps) {
  return <h1 className={`sam-type-page-title text-fg-primary m-0 ${className}`} style={style}>{children}</h1>;
}

export function SectionHeading({ children, className = '', style }: TierProps) {
  return <h2 className={`sam-type-section-heading text-fg-primary m-0 ${className}`} style={style}>{children}</h2>;
}

export function CardTitle({ children, className = '', style }: TierProps) {
  return <h3 className={`sam-type-card-title text-fg-primary m-0 ${className}`} style={style}>{children}</h3>;
}

export function Body({ children, className = '', style }: TierProps) {
  return <p className={`sam-type-body text-fg-primary m-0 ${className}`} style={style}>{children}</p>;
}

export function Secondary({ children, className = '', style }: TierProps) {
  return <p className={`sam-type-secondary text-fg-muted m-0 ${className}`} style={style}>{children}</p>;
}

export function Caption({ children, className = '', style }: TierProps) {
  return <span className={`sam-type-caption text-fg-muted m-0 ${className}`} style={style}>{children}</span>;
}
