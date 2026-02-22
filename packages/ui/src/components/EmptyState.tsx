import { type ReactNode, type CSSProperties } from 'react';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: ReactNode;
  heading: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: 'var(--sam-space-8)',
};

const iconStyle: CSSProperties = {
  width: 48,
  height: 48,
  color: 'var(--sam-color-fg-muted)',
  marginBottom: 'var(--sam-space-4)',
};

const headingStyle: CSSProperties = {
  fontSize: 'var(--sam-type-section-heading-size)',
  fontWeight: 'var(--sam-type-section-heading-weight)',
  lineHeight: 'var(--sam-type-section-heading-line-height)',
  color: 'var(--sam-color-fg-primary)',
  textAlign: 'center',
  margin: 0,
};

const descriptionStyle: CSSProperties = {
  fontSize: 'var(--sam-type-secondary-size)',
  lineHeight: 'var(--sam-type-secondary-line-height)',
  color: 'var(--sam-color-fg-muted)',
  textAlign: 'center',
  maxWidth: 320,
  marginTop: 'var(--sam-space-2)',
};

export function EmptyState({ icon, heading, description, action }: EmptyStateProps) {
  return (
    <div style={containerStyle}>
      {icon && <div style={iconStyle}>{icon}</div>}
      <h3 style={headingStyle}>{heading}</h3>
      {description && <p style={descriptionStyle}>{description}</p>}
      {action && (
        <div style={{ marginTop: 'var(--sam-space-4)' }}>
          <Button variant="primary" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
