import type { SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className, ...props }: SelectProps) {
  return (
    <select
      className={`w-full min-h-11 rounded-sm border border-[var(--sam-form-border)] bg-[var(--sam-form-bg)] text-fg-primary py-2.5 px-3 text-[0.95rem] transition-[border-color,box-shadow] duration-150 ease-in-out hover:border-[var(--sam-form-border-hover)] focus:border-[var(--sam-form-border-focus)] focus:shadow-[0_0_0_3px_var(--sam-form-focus-ring)] focus:outline-none ${className ?? ''}`}
      {...props}
    />
  );
}
