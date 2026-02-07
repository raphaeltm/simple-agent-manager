import type { CSSProperties } from 'react';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 16,
  md: 24,
  lg: 32,
};

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  const px = sizeMap[size];
  const style: CSSProperties = {
    display: 'inline-block',
    width: px,
    height: px,
    border: `2px solid transparent`,
    borderTopColor: 'var(--sam-color-accent-primary)',
    borderRadius: '50%',
    animation: 'sam-spin 0.6s linear infinite',
  };

  return <span className={className} style={style} role="status" aria-label="Loading" />;
}
