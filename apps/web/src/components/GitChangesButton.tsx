import { type CSSProperties, type FC } from 'react';
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
  const buttonStyle: CSSProperties = {
    position: 'relative',
    background: 'none',
    border: 'none',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--sam-color-fg-muted)' : 'var(--sam-color-fg-primary)',
    opacity: disabled ? 0.5 : 1,
    padding: isMobile ? (compactMobile ? '6px' : '8px') : '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: isMobile ? mobileTargetSize : 32,
    minHeight: isMobile ? mobileTargetSize : 32,
    flexShrink: 0,
  };

  const badgeStyle: CSSProperties = {
    position: 'absolute',
    top: isMobile ? 4 : 0,
    right: isMobile ? 4 : 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'var(--sam-color-accent-primary)',
    color: '#fff',
    fontSize: '0.625rem',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    lineHeight: 1,
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={isStale ? 'View git changes (status may be stale)' : 'View git changes'}
      style={buttonStyle}
    >
      <GitBranch size={iconSize} />
      {changeCount != null && changeCount > 0 && (
        <span style={badgeStyle}>{changeCount > 99 ? '99+' : changeCount}</span>
      )}
      {isStale && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: isMobile ? 4 : 2,
            right: isMobile ? 4 : 2,
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: '#f59e0b',
            boxShadow: '0 0 0 1px #1a1b26',
          }}
        />
      )}
    </button>
  );
};
