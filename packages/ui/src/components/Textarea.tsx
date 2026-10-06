import type { TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`w-full min-w-0 rounded-sm border border-border-default bg-inset px-3 py-2.5 text-[0.95rem] text-fg-primary placeholder:text-fg-muted resize-y ${className ?? ''}`}
      {...props}
    />
  );
});
