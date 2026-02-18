import { type CSSProperties, type FC } from 'react';
import { Folder } from 'lucide-react';

interface FileBrowserButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isMobile: boolean;
  compactMobile?: boolean;
}

export const FileBrowserButton: FC<FileBrowserButtonProps> = ({
  onClick,
  disabled,
  isMobile,
  compactMobile = false,
}) => {
  const mobileTargetSize = compactMobile ? 36 : 44;
  const iconSize = isMobile ? (compactMobile ? 16 : 18) : 16;
  const buttonStyle: CSSProperties = {
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

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Browse files"
      style={buttonStyle}
    >
      <Folder size={iconSize} />
    </button>
  );
};
