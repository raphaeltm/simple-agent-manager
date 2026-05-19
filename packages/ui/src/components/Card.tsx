import type { ComponentPropsWithoutRef } from 'react';

export interface CardProps extends ComponentPropsWithoutRef<'div'> {
  className?: string;
  variant?: 'default' | 'glass';
}

const variantClasses: Record<NonNullable<CardProps['variant']>, string> = {
  default: 'bg-surface border border-border-default',
  glass: 'glass-surface',
};

export function Card({ children, className = '', variant = 'default', ...props }: CardProps) {
  return (
    <div
      className={`${variantClasses[variant]} rounded-lg shadow-sm ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
