import type { ReactNode } from 'react';

interface ContainerProps {
  children: ReactNode;
  className?: string;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl';
}

const maxWidthClasses: Record<NonNullable<ContainerProps['maxWidth']>, string> = {
  sm: 'max-w-[40rem]',
  md: 'max-w-[56rem]',
  lg: 'max-w-[72rem]',
  xl: 'max-w-[80rem]',
};

export function Container({ children, className = '', maxWidth = 'lg' }: ContainerProps) {
  return (
    <div className={`w-full ${maxWidthClasses[maxWidth]} mx-auto px-4 ${className}`}>
      {children}
    </div>
  );
}
