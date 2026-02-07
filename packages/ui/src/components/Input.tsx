import type { CSSProperties, InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export function Input(props: InputProps) {
  const style: CSSProperties = {
    width: '100%',
    minHeight: '44px',
    borderRadius: 'var(--sam-radius-sm)',
    border: '1px solid var(--sam-color-border-default)',
    backgroundColor: '#ffffff',
    color: '#111827',
    padding: '10px 12px',
    fontSize: '0.95rem',
  };

  return <input {...props} style={{ ...style, ...props.style }} />;
}
