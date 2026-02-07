import type { CSSProperties, SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select(props: SelectProps) {
  const style: CSSProperties = {
    width: '100%',
    minHeight: '44px',
    borderRadius: 'var(--sam-radius-sm)',
    border: '1px solid var(--sam-color-border-default)',
    backgroundColor: 'var(--sam-color-bg-inset)',
    color: 'var(--sam-color-fg-primary)',
    padding: '10px 12px',
    fontSize: '0.95rem',
  };

  return <select {...props} style={{ ...style, ...props.style }} />;
}
