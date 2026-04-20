import type { FC, ReactNode } from 'react';

interface SectionHeaderProps {
  icon: ReactNode;
  iconBg: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}

export const SectionHeader: FC<SectionHeaderProps> = ({ icon, iconBg, title, description, actions }) => (
  <div className="flex items-center gap-3 mb-4">
    <div
      className="h-10 w-10 rounded-md flex items-center justify-center shrink-0"
      style={{ backgroundColor: iconBg }}
    >
      {icon}
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-fg-primary" style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number }}>
        {title}
      </div>
      {description && (
        <div className="text-fg-muted" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          {description}
        </div>
      )}
    </div>
    {actions && <div className="shrink-0">{actions}</div>}
  </div>
);
