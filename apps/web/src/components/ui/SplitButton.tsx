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
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <style>{`
        .split-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
        .split-btn-chevron:hover:not(:disabled) { filter: brightness(1.1); }
        .split-btn-option:hover { background-color: var(--sam-color-bg-surface-hover); }
      `}</style>
      {/* Primary action button */}
      <button
        type="button"
        className="split-btn-primary"
        onClick={onPrimaryAction}
        disabled={isDisabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--sam-space-2)',
          padding: 'var(--sam-space-2) var(--sam-space-4)',
          backgroundColor: 'var(--sam-color-accent-primary)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--sam-radius-md) 0 0 var(--sam-radius-md)',
          fontSize: 'var(--sam-type-secondary-size)',
          fontWeight: 500,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.5 : 1,
          transition: 'filter 0.15s',
        }}
      >
        {loading && (
          <span style={{
            display: 'inline-block',
            width: '14px',
            height: '14px',
            border: '2px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite',
          }} />
        )}
        {primaryLabel}
      </button>

      {/* Chevron dropdown toggle */}
      <button
        type="button"
        className="split-btn-chevron"
        onClick={() => !isDisabled && setOpen(!open)}
        disabled={isDisabled}
        aria-label="More options"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: 'var(--sam-space-2) var(--sam-space-2)',
          backgroundColor: 'var(--sam-color-accent-primary)',
          color: '#fff',
          border: 'none',
          borderLeft: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '0 var(--sam-radius-md) var(--sam-radius-md) 0',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.5 : 1,
          transition: 'filter 0.15s',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '4px',
          minWidth: '180px',
          backgroundColor: 'var(--sam-color-bg-surface)',
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          zIndex: 100,
          overflow: 'hidden',
        }}>
          {options.map((option, idx) => (
            <button
              key={idx}
              type="button"
              className="split-btn-option"
              onClick={() => {
                option.onClick();
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: 'var(--sam-space-2) var(--sam-space-3)',
                backgroundColor: 'transparent',
                color: 'var(--sam-color-fg-primary)',
                border: 'none',
                fontSize: 'var(--sam-type-secondary-size)',
                cursor: 'pointer',
                transition: 'background-color 0.1s',
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
