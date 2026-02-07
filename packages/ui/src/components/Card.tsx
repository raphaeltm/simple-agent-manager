import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, className = '', style }: CardProps) {
  const baseStyle: CSSProperties = {
    backgroundColor: '#ffffff',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-lg)',
    boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
  };

  return (
    <div className={className} style={{ ...baseStyle, ...style }}>
      {children}
    </div>
  );
}
