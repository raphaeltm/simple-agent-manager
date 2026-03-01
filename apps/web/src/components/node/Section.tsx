import type { FC, ReactNode } from 'react';

interface SectionProps {
  children: ReactNode;
}

export const Section: FC<SectionProps> = ({ children }) => (
  <div className="bg-surface rounded-lg border border-border-default p-6">
    {children}
  </div>
);
