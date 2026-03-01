import { type FC, useState, useRef, useEffect, useCallback } from 'react';

export interface SplitButtonOption {
  label: string;
  onClick: () => void;
}

export interface SplitButtonProps {
  primaryLabel: string;
  onPrimaryAction: () => void;
  options: SplitButtonOption[];
  disabled?: boolean;
  loading?: boolean;
}

export const SplitButton: FC<SplitButtonProps> = ({
  primaryLabel,
  onPrimaryAction,
  options,
  disabled = false,
  loading = false,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [open, handleClickOutside, handleKeyDown]);

  const isDisabled = disabled || loading;

  return (
    <div ref={containerRef} className="relative inline-flex">
      {/* Primary action button */}
      <button
        type="button"
        onClick={onPrimaryAction}
        disabled={isDisabled}
        className={`inline-flex items-center gap-2 px-4 py-2 bg-accent text-white border-none text-sm font-medium transition-[filter] duration-150 ${
          isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:brightness-110'
        }`}
        style={{ borderRadius: 'var(--sam-radius-md) 0 0 var(--sam-radius-md)' }}
      >
        {loading && (
          <span
            className="inline-block w-3.5 h-3.5 rounded-full animate-spin"
            style={{
              border: '2px solid rgba(255,255,255,0.3)',
              borderTopColor: '#fff',
            }}
          />
        )}
        {primaryLabel}
      </button>

      {/* Chevron dropdown toggle */}
      <button
        type="button"
        onClick={() => !isDisabled && setOpen(!open)}
        disabled={isDisabled}
        aria-label="More options"
        className={`inline-flex items-center px-2 py-2 bg-accent text-white border-none transition-[filter] duration-150 ${
          isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:brightness-110'
        }`}
        style={{
          borderLeft: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '0 var(--sam-radius-md) var(--sam-radius-md) 0',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute top-full right-0 mt-1 min-w-[180px] bg-surface border border-border-default rounded-md shadow-dropdown z-dropdown overflow-hidden">
          {options.map((option, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                option.onClick();
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-2 bg-transparent text-fg-primary border-none text-sm cursor-pointer transition-colors duration-100 hover:bg-surface-hover"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
