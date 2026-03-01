import type { SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className, ...props }: SelectProps) {
  return (
    <select
      className={`w-full min-h-11 rounded-sm border border-border-default bg-inset text-fg-primary py-2.5 px-3 text-[0.95rem] ${className ?? ''}`}
      {...props}
    />
  );
}
