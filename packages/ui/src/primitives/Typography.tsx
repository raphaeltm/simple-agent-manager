import type { CSSProperties, ReactNode } from 'react';

type TypographyVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'body-muted'
  | 'caption';

interface TypographyProps {
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div';
  children: ReactNode;
  variant?: TypographyVariant;
  className?: string;
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
}: TypographyProps) {
  const Tag = as;
  return (
    <Tag style={variantStyles[variant]} className={className}>
      {children}
    </Tag>
  );
}
