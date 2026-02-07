import type { CSSProperties, ReactNode } from 'react';

interface ContainerProps {
  children: ReactNode;
  className?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

const maxWidthMap: Record<NonNullable<ContainerProps['maxWidth']>, string> = {
  sm: '40rem',
  md: '56rem',
  lg: '72rem',
  xl: '80rem',
};

export function Container({ children, className = '', maxWidth = 'lg' }: ContainerProps) {
  const style: CSSProperties = {
    width: '100%',
    maxWidth: maxWidthMap[maxWidth],
    margin: '0 auto',
    paddingLeft: 'var(--sam-space-4)',
    paddingRight: 'var(--sam-space-4)',
  };

  return (
    <div style={style} className={className}>
      {children}
    </div>
  );
}
