import type { FC, ReactNode } from 'react';

interface SectionHeaderProps {
  icon: ReactNode;
  iconBg: string;
  title: string;
  description?: string;
}

export const SectionHeader: FC<SectionHeaderProps> = ({ icon, iconBg, title, description }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--sam-space-3)',
      marginBottom: 'var(--sam-space-4)',
    }}
  >
    <div
      style={{
        height: 40,
        width: 40,
        backgroundColor: iconBg,
        borderRadius: 'var(--sam-radius-md)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {icon}
    </div>
    <div>
      <div
        style={{
          fontSize: 'var(--sam-type-section-heading-size)',
          fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number,
          color: 'var(--sam-color-fg-primary)',
        }}
      >
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
          {description}
        </div>
      )}
    </div>
  </div>
);
