import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`w-full min-h-11 rounded-sm border border-border-default bg-inset text-fg-primary py-2.5 px-3 text-[0.95rem] ${className ?? ''}`}
      {...props}
    />
  );
});
