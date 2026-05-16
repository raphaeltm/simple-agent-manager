import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  variant?: 'default' | 'glass';
}

const variantClasses: Record<NonNullable<CardProps['variant']>, string> = {
  default: 'bg-surface border border-border-default',
  glass: 'glass-surface glass-card-glow',
};

export function Card({ children, className = '', style, variant = 'default' }: CardProps) {
  return (
    <div
      className={`${variantClasses[variant]} rounded-lg shadow-sm ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
