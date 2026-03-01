import type { ReactNode } from 'react';
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

export function EmptyState({ icon, heading, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center p-8">
      {icon && <div className="w-12 h-12 text-fg-muted mb-4">{icon}</div>}
      <h3 className="sam-type-section-heading text-fg-primary text-center m-0">{heading}</h3>
      {description && (
        <p className="sam-type-secondary text-fg-muted text-center max-w-xs mt-2">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4">
          <Button variant="primary" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
