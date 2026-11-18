import { Search, X } from 'lucide-react';
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  /** Shown as a clear button while there is text. */
  clearLabel?: string;
  trailing?: ReactNode;
  size?: 'md' | 'lg';
  className?: string;
}

/** A search input recessed into the glass as a well. 16px text on phones so iOS does not zoom. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onValueChange, label, clearLabel = 'Clear search', trailing, size = 'md', className = '', placeholder, ...props },
  ref
) {
  return (
    <div
      className={`sam-well flex items-center gap-2.5 rounded-[var(--sam-radius-control)] pr-1.5 pl-3 text-fg-muted focus-within:shadow-[inset_0_1px_2px_var(--sam-glass-v2-well-shade),inset_0_0_0_1px_var(--sam-form-border-focus),0_0_0_3px_var(--sam-form-focus-ring)] ${
        size === 'lg' ? 'h-12' : 'h-10'
      } ${className}`}
    >
      <Search size={size === 'lg' ? 20 : 16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="min-w-0 flex-1 border-0 bg-transparent text-base text-fg-primary outline-none placeholder:text-fg-muted md:text-sm"
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label={clearLabel}
          className="inline-grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-fg-muted hover:text-fg-primary"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      {trailing}
    </div>
  );
});
