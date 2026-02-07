import { forwardRef } from 'react';
import type { CSSProperties, InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
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

  return <input ref={ref} {...props} style={{ ...style, ...props.style }} />;
});
