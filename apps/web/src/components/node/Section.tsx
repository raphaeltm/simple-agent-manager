import type { FC, ReactNode } from 'react';

interface SectionProps {
  children: ReactNode;
}

export const Section: FC<SectionProps> = ({ children }) => (
  <div
    style={{
      backgroundColor: 'var(--sam-color-bg-surface)',
      borderRadius: 'var(--sam-radius-lg)',
      border: '1px solid var(--sam-color-border-default)',
      padding: 'var(--sam-space-6)',
    }}
  >
    {children}
  </div>
);
