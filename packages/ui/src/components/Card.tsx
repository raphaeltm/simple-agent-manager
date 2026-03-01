import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, className = '', style }: CardProps) {
  return (
    <div
      className={`bg-surface border border-border-default rounded-lg shadow-sm ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
