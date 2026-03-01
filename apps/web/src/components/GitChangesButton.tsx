import { type FC } from 'react';
import { GitBranch } from 'lucide-react';

interface GitChangesButtonProps {
  onClick: () => void;
  changeCount?: number;
  disabled?: boolean;
  isMobile: boolean;
  compactMobile?: boolean;
  isStale?: boolean;
}

export const GitChangesButton: FC<GitChangesButtonProps> = ({
  onClick,
  changeCount,
  disabled,
  isMobile,
  compactMobile = false,
  isStale = false,
}) => {
  const mobileTargetSize = compactMobile ? 36 : 44;
  const iconSize = isMobile ? (compactMobile ? 16 : 18) : 16;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={isStale ? 'View git changes (status may be stale)' : 'View git changes'}
      className="relative bg-transparent border-none flex items-center justify-center shrink-0"
      style={{
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--sam-color-fg-muted)' : 'var(--sam-color-fg-primary)',
        opacity: disabled ? 0.5 : 1,
        padding: isMobile ? (compactMobile ? '6px' : '8px') : '4px',
        minWidth: isMobile ? mobileTargetSize : 32,
        minHeight: isMobile ? mobileTargetSize : 32,
      }}
    >
      <GitBranch size={iconSize} />
      {changeCount != null && changeCount > 0 && (
        <span
          className="absolute min-w-4 h-4 rounded-full bg-accent text-fg-on-accent flex items-center justify-center font-bold leading-none"
          style={{
            top: isMobile ? 4 : 0,
            right: isMobile ? 4 : 0,
            fontSize: '0.625rem',
            padding: '0 4px',
          }}
        >{changeCount > 99 ? '99+' : changeCount}</span>
      )}
      {isStale && (
        <span
          aria-hidden="true"
          className="absolute w-[7px] h-[7px] rounded-full bg-warning shadow-overlay"
          style={{
            bottom: isMobile ? 4 : 2,
            right: isMobile ? 4 : 2,
          }}
        />
      )}
    </button>
  );
};
