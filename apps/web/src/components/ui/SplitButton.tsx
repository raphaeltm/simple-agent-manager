import {
  type CSSProperties,
  type FC,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

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
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = useCallback(() => {
    const trigger = containerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 180;
    const gutter = 8;
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: Math.max(
        gutter,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - gutter)
      ),
      minWidth: menuWidth,
      zIndex: 'var(--sam-z-dropdown)' as unknown as number,
    });
  }, []);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    const target = e.target as Node;
    if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
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
      window.addEventListener('resize', updateMenuPosition);
      window.addEventListener('scroll', updateMenuPosition, true);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('resize', updateMenuPosition);
        window.removeEventListener('scroll', updateMenuPosition, true);
      };
    }
  }, [open, handleClickOutside, handleKeyDown, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, updateMenuPosition]);

  const isDisabled = disabled || loading;

  return (
    <div ref={containerRef} className="relative inline-flex">
      {/* Primary action button */}
      <button
        type="button"
        onClick={onPrimaryAction}
        disabled={isDisabled}
        className={`inline-flex items-center gap-2 px-4 py-2 bg-accent text-fg-on-accent border-none text-sm font-medium transition-[filter] duration-150 ${
          isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:brightness-110'
        }`}
        style={{ borderRadius: 'var(--sam-radius-md) 0 0 var(--sam-radius-md)' }}
      >
        {loading && (
          <span
            className="inline-block w-3.5 h-3.5 rounded-full animate-spin"
            style={{
              border: '2px solid var(--sam-button-on-accent-spinner-border)',
              borderTopColor: 'var(--sam-color-fg-on-accent)',
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
        className={`inline-flex items-center px-2 py-2 bg-accent text-fg-on-accent border-none transition-[filter] duration-150 ${
          isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:brightness-110'
        }`}
        style={{
          borderLeft: '1px solid var(--sam-button-on-accent-border)',
          borderRadius: '0 var(--sam-radius-md) var(--sam-radius-md) 0',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Dropdown menu */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="glass-surface rounded-md shadow-dropdown overflow-hidden"
            style={menuStyle}
          >
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
          </div>,
          document.body
        )}
    </div>
  );
};
