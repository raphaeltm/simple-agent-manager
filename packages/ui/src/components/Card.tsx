import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, className = '', style }: CardProps) {
  const baseStyle: CSSProperties = {
    backgroundColor: 'var(--sam-color-bg-surface)',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-lg)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
  };

  return (
    <div className={className} style={{ ...baseStyle, ...style }}>
      {children}
    </div>
  );
}
