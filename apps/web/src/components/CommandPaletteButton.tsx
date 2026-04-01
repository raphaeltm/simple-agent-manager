import { Search } from 'lucide-react';
import { type FC } from 'react';

interface CommandPaletteButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isMobile: boolean;
  compactMobile?: boolean;
}

export const CommandPaletteButton: FC<CommandPaletteButtonProps> = ({
  onClick,
  disabled,
  isMobile,
  compactMobile = false,
}) => {
  const iconSize = isMobile ? (compactMobile ? 16 : 18) : 16;

  const className = [
    'bg-transparent border-none flex items-center justify-center shrink-0',
    disabled ? 'cursor-default text-fg-muted opacity-50' : 'cursor-pointer text-fg-primary',
    isMobile
      ? compactMobile
        ? 'p-1.5 min-w-9 min-h-9'
        : 'p-2 min-w-11 min-h-11'
      : 'p-1 min-w-8 min-h-8',
  ].join(' ');

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Open command palette"
      className={className}
    >
      <Search size={iconSize} />
    </button>
  );
};
